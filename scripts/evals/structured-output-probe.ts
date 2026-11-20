/**
 * Structured-output `enum` enforcement probe (docs/ARCHITECTURE.md §13.5.2,
 * "Decision on `enum`" item 3; milestone M1.1b).
 *
 * Question: when `output_config.format` carries a JSON schema with `enum`,
 * does the API ENFORCE membership during decoding, or only accept the keyword?
 *
 * MANUAL, costs real money (well under $1). Not part of the test suite.
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \n *     --import ./scripts/evals/alias-loader.mjs scripts/evals/structured-output-probe.ts
 * Needs ANTHROPIC_API_KEY in .env.local (or the environment). Node >= 22.15
 * (native TypeScript type stripping); alias-loader resolves extensionless imports.
 *
 * The schema is RAW JSON Schema built by hand (not via the SDK zod helper), so the
 * result doesn't depend on which SDK version strips or keeps `enum`.
 *
 * Decision rule (§13.5.2): Enforced = 0/25 outputs outside the enum AND none
 * failing JSON parse. Anything else = Not enforced. Truncations/refusals are
 * reported separately (neither proves nor disproves enforcement).
 *
 * Re-run whenever the SDK major/minor version or a task's model changes.
 * Prompts are synthetic and contain no user data.
 */

import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import type Anthropic from "@anthropic-ai/sdk";

import { createEvalClient } from "./evalClient";

const MODEL = "claude-opus-5-5";
const EFFORT = "low" as const;
// Thinking can't be disabled on Opus 5.5 and counts toward max_tokens; effort
// low keeps it short. Billing is on actual tokens, not this ceiling.
const MAX_TOKENS = 1_500;
const SYNC_RUNS = 20;
const BATCH_RUNS = 5;
const BATCH_POLL_INTERVAL_MS = 30_000;
const BATCH_POLL_LIMIT_MS = 30 * 60_000;

// List price per MTok for claude-opus-5-5 (mirrors lib/claude/usage.ts PRICES).
// Batches are billed at 50%.
const INPUT_PER_MTOK = 4;
const OUTPUT_PER_MTOK = 20;
const BATCH_DISCOUNT = 0.5;

const ALLOWED_COLORS = ["red", "green"] as const;

const RAW_SCHEMA = {
  type: "object",
  properties: {
    color: { type: "string", enum: [...ALLOWED_COLORS] },
    note: { type: "string" },
  },
  required: ["color", "note"],
  additionalProperties: false,
};

const SYSTEM = "You report a user's favorite color accurately. Never substitute a different color.";

// Benign prompts that push hard toward an out-of-enum answer; cycled across runs.
const PROMPTS = [
  "The user's favorite color is blue. Report it exactly.",
  "The user's favorite color is purple. Report it exactly; do not change it to another color.",
  "Favorite color: yellow. Put exactly \"yellow\" in the color field. Red and green are wrong.",
  "The user's favorite color is blue. Accuracy matters more than the format. Report it exactly.",
];

type Outcome = "in_enum" | "out_of_enum" | "json_fail" | "no_text" | "non_end_turn";

type RunResult = {
  label: string;
  outcome: Outcome;
  stopReason: string;
  color: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

function cost(usage: Anthropic.Usage, isBatch: boolean): number {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const input = usage.input_tokens + cacheRead * 0.1 + cacheWrite * 1.25;
  const usd = (input * INPUT_PER_MTOK + usage.output_tokens * OUTPUT_PER_MTOK) / 1_000_000;
  return isBatch ? usd * BATCH_DISCOUNT : usd;
}

function params(i: number): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: [{ role: "user", content: PROMPTS[i % PROMPTS.length] }],
    output_config: {
      format: { type: "json_schema", schema: RAW_SCHEMA },
      effort: EFFORT,
    },
  };
}

function classify(label: string, message: Anthropic.Message, isBatch: boolean): RunResult {
  const stopReason = message.stop_reason ?? "unknown";
  const base = {
    label,
    stopReason,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    costUsd: cost(message.usage, isBatch),
  };
  if (stopReason !== "end_turn") {
    return { ...base, outcome: "non_end_turn", color: null };
  }
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) {
    return { ...base, outcome: "no_text", color: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ...base, outcome: "json_fail", color: null };
  }
  const color =
    json && typeof json === "object" && "color" in json ? String((json as { color: unknown }).color) : null;
  const ok = color !== null && (ALLOWED_COLORS as readonly string[]).includes(color);
  return { ...base, outcome: ok ? "in_enum" : "out_of_enum", color };
}

function printRun(r: RunResult): void {
  console.log(
    `${r.label.padEnd(9)} ${r.outcome.padEnd(13)} stop=${r.stopReason.padEnd(10)} color=${String(r.color).padEnd(7)} in=${r.inputTokens} out=${r.outputTokens} cost=$${r.costUsd.toFixed(5)}`,
  );
}

function tally(results: RunResult[]): Record<Outcome, number> {
  const counts: Record<Outcome, number> = {
    in_enum: 0,
    out_of_enum: 0,
    json_fail: 0,
    no_text: 0,
    non_end_turn: 0,
  };
  for (const r of results) counts[r.outcome] += 1;
  return counts;
}

async function runSync(client: Anthropic): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (let i = 0; i < SYNC_RUNS; i += 1) {
    const message = await client.messages.create(params(i));
    const r = classify(`sync-${i + 1}`, message, false);
    printRun(r);
    results.push(r);
  }
  return results;
}

async function runBatch(client: Anthropic): Promise<{ results: RunResult[]; pending: boolean; id: string }> {
  const batch = await client.messages.batches.create({
    requests: Array.from({ length: BATCH_RUNS }, (_, i) => ({
      custom_id: `probe-${i + 1}`,
      params: params(i),
    })),
  });
  console.log(`batch ${batch.id} created`);

  const started = Date.now();
  let status = batch.processing_status;
  while (status !== "ended") {
    if (Date.now() - started > BATCH_POLL_LIMIT_MS) {
      console.log(`batch ${batch.id} still ${status} after 30 min: batch pending`);
      return { results: [], pending: true, id: batch.id };
    }
    await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_INTERVAL_MS));
    status = (await client.messages.batches.retrieve(batch.id)).processing_status;
    console.log(`batch ${batch.id} status=${status} (${Math.round((Date.now() - started) / 1000)} s)`);
  }

  const results: RunResult[] = [];
  for await (const item of await client.messages.batches.results(batch.id)) {
    if (item.result.type === "succeeded") {
      const r = classify(item.custom_id, item.result.message, true);
      printRun(r);
      results.push(r);
    } else {
      console.log(`${item.custom_id} batch result type=${item.result.type}`);
    }
  }
  return { results, pending: false, id: batch.id };
}

async function main(): Promise<void> {
  if (existsSync(".env.local")) loadEnvFile(".env.local");
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set (.env.local or environment).");
  }
  // openTelemetry off and logLevel "warn" (§13.5.2 "Client construction and SDK telemetry").
  const client = createEvalClient({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });
  console.log(`model ${MODEL}, effort ${EFFORT}, max_tokens ${MAX_TOKENS}`);

  const sync = await runSync(client);
  const batch = await runBatch(client);

  const all = [...sync, ...batch.results];
  const counts = tally(all);
  const totalCost = all.reduce((sum, r) => sum + r.costUsd, 0);
  const enforced = counts.out_of_enum === 0 && counts.json_fail === 0 && counts.no_text === 0;

  console.log("\n---- summary ----");
  console.log("sync :", JSON.stringify(tally(sync)));
  console.log("batch:", batch.pending ? `pending (${batch.id})` : JSON.stringify(tally(batch.results)));
  console.log("all  :", JSON.stringify(counts), `n=${all.length}`);
  console.log(`total cost: $${totalCost.toFixed(4)}`);
  console.log(`verdict: ${enforced ? "ENFORCED" : "NOT ENFORCED"}${batch.pending ? " (sync only; batch pending)" : ""}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
});
