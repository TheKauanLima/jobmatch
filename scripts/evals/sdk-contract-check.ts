/**
 * SDK contract check (docs/ARCHITECTURE.md §13.5.2 "Decision on `enum`" item 5).
 *
 * Re-verifies, on the pinned `@anthropic-ai/sdk`, everything `lib/claude`
 * relies on, and prints PASS/FAIL/INFO per item with how it was checked:
 *   live   = a real API call (costs money; total well under $0.10)
 *   local  = SDK code exercised in-process with a fake fetch or no network
 *   source = read from the SDK source/type definitions (noted, not executed)
 *
 * MANUAL. Re-run on EVERY SDK version change; a FAIL blocks the bump.
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     --import ./scripts/evals/alias-loader.mjs scripts/evals/sdk-contract-check.ts
 * Needs ANTHROPIC_API_KEY in .env.local (or the environment).
 *
 * Uses lib/claude's own client construction (`getClaudeClient`), so it checks
 * the client the app actually runs. Header capture wraps global fetch and logs
 * only `anthropic-version` / `anthropic-beta` values, never bodies or keys.
 * Every prompt is synthetic (no user data). Usage is tallied by an in-memory
 * sink; nothing is written to the database.
 *
 * Item (x) (telemetry off, M1.1c) is local + source and needs no network. Run
 * it alone with `--only-x` (no spend).
 *
 * Item (ix) re-runs the v1 analyze / match Claude flows (`analyzeResume`,
 * `matchResumeToJob`: real prompts, callStructured, semantic validation and
 * the single retry) on a synthetic resume and job posting.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import {
  __resetClaudeClientForTests,
  callStructured,
  classifySdkError,
  getClaudeClient,
  OTEL_CONTENT_MODE_ENV,
  SERVER_SIDE_FALLBACK_BETA,
} from "@/lib/claude/client";
import { ClaudeApiError, ClaudeBadRequestError, ClaudeConfigurationError } from "@/lib/claude/errors";
import { buildOutputFormat } from "@/lib/claude/outputFormat";
import { analyzeResume } from "@/lib/claude/prompts/analyzeResume";
import { matchResumeToJob } from "@/lib/claude/prompts/matchResumeToJob";
import { setUsageSink, summarizeUsage } from "@/lib/claude/usage";

import { createEvalClient } from "./evalClient";

const MODEL = "claude-opus-5-5";
const EXPECTED_API_VERSION = "2026-10-21";
const BATCH_POLL_INTERVAL_MS = 20_000;
const BATCH_POLL_LIMIT_MS = 30 * 60_000;

// ---- result bookkeeping -----------------------------------------------------

type Status = "PASS" | "FAIL" | "INFO";
type How = "live" | "local" | "source";
const results: Array<{ item: string; status: Status; how: How; detail: string }> = [];

function record(item: string, status: Status, how: How, detail: string): void {
  results.push({ item, status, how, detail });
  console.log(`[${status}] (${how}) ${item}: ${detail}`);
}

function check(item: string, ok: boolean, how: How, detail: string): void {
  record(item, ok ? "PASS" : "FAIL", how, detail);
}

function errName(err: unknown): string {
  return err instanceof Error ? `${err.constructor.name}${err instanceof ClaudeApiError ? `(${err.code})` : ""}` : typeof err;
}

let spendUsd = 0;

// ---- header capture (installed before getClaudeClient builds the client) ----

const TRACE_HEADERS = ["traceparent", "tracestate", "baggage"];
type Captured = {
  path: string;
  version: string | null;
  beta: string | null;
  traceHeaders: string[];
  /** Answered by a local stub (item (x)); excluded from the live tallies. */
  stubbed: boolean;
};
const captured: Captured[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("anthropic.com")) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    captured.push({
      path: new URL(url).pathname,
      version: headers.get("anthropic-version"),
      beta: headers.get("anthropic-beta"),
      // Names only, never values.
      traceHeaders: TRACE_HEADERS.filter((name) => headers.has(name)),
      stubbed: fetchOverride !== null,
    });
  }
  return fetchOverride ? fetchOverride(input, init) : realFetch(input, init);
}) as typeof fetch;

/** When set, requests are captured but answered locally instead of hitting the network (item (x)). */
let fetchOverride: typeof fetch | null = null;

// ---- fixtures -----------------------------------------------------------------

const Level = z.enum(["intern", "junior", "mid", "senior"]);
const EnumFixture = z.object({
  plain: z.enum(["red", "green"]),
  nullable: z.enum(["a", "b", "c"]).nullable(),
  list: z.array(z.enum(["x", "y"])),
  reusedOne: Level,
  reusedTwo: z.object({ level: Level.nullable() }),
  note: z.string(),
});

const FIXTURE_SYSTEM = "Fill every field of the JSON schema with any valid values. Keep `note` under ten words.";
const FIXTURE_USER = "A mid-level role. Favorite color: red. List: x then y.";

const SYNTHETIC_RESUME = `Alex Example
Software engineering student, Example State University (B.S. Computer Science, expected 2027).
Experience: Backend intern at Sample Corp (summer 2026): built REST endpoints in TypeScript/Node.js,
wrote PostgreSQL migrations, added unit tests with Vitest. Teaching assistant for Data Structures.
Projects: campus event finder (Next.js, Supabase); CLI budget tracker (Python).
Skills: TypeScript, JavaScript, Python, SQL, Git, REST APIs.`;

const SYNTHETIC_JOB = `Junior Backend Engineer at Placeholder Inc.
Build and maintain Node.js/TypeScript services and PostgreSQL schemas. Write tests.
Requirements: experience with TypeScript or JavaScript, SQL, Git. Nice to have: cloud deployment, Docker.`;

function rawParams(maxTokens: number): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: maxTokens,
    system: FIXTURE_SYSTEM,
    messages: [{ role: "user", content: FIXTURE_USER }],
    output_config: { format: buildOutputFormat(EnumFixture), effort: "low" },
  };
}

function finalText(content: Array<{ type: string; text?: string }>): string {
  let start = 0;
  content.forEach((b, i) => {
    if (b.type === "fallback") start = i + 1;
  });
  return content
    .slice(start)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

function fixtureValid(text: string): boolean {
  try {
    return EnumFixture.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

// ---- items --------------------------------------------------------------------

async function itemsOneToThreeSync(): Promise<void> {
  const before = captured.length;
  try {
    const result = await callStructured({
      task: "extractJobRequirements", // effort low; the task name only selects config here
      system: [{ type: "text", text: FIXTURE_SYSTEM }],
      userContent: FIXTURE_USER,
      schema: EnumFixture,
      usageContext: { userId: null, taskId: null, taskAttempt: null },
    });
    const req = captured.slice(before).find((c) => c.path === "/v1/messages");
    check(
      "(i) anthropic-version header",
      req?.version === EXPECTED_API_VERSION,
      "live",
      `sent anthropic-version=${req?.version ?? "none"}`,
    );
    check(
      "(ii) beta create + fallbacks + withResponse -> data + request_id",
      result.requestId !== null && result.stopReason === "end_turn" && (req?.beta ?? "").includes(SERVER_SIDE_FALLBACK_BETA),
      "live",
      `stop=${result.stopReason} request_id=${result.requestId ? "present" : "null"} anthropic-beta=${req?.beta ?? "none"} served=${result.model}`,
    );
    check(
      "(iii-a) enum fixture accepted, sync",
      result.stopReason === "end_turn",
      "live",
      `end_turn, zod-valid (plain=${result.value.plain}, nullable=${result.value.nullable}, list=[${result.value.list.join(",")}])`,
    );
  } catch (err) {
    record("(i)-(iii-a) sync enum fixture via callStructured", "FAIL", "live", errName(err));
  }
}

type BatchHandle = { label: string; id: string; beta: boolean };

async function createBatches(client: Anthropic): Promise<BatchHandle[]> {
  const handles: BatchHandle[] = [];
  try {
    const plain = await client.messages.batches.create({
      requests: [{ custom_id: "enum-fixture", params: rawParams(2_000) as Anthropic.MessageCreateParamsNonStreaming }],
    });
    handles.push({ label: "plain", id: plain.id, beta: false });
  } catch (err) {
    record("(iii-b) enum fixture batch create", "FAIL", "live", errName(err));
  }
  try {
    const withFallback = await client.beta.messages.batches.create({
      betas: [SERVER_SIDE_FALLBACK_BETA],
      requests: [
        { custom_id: "enum-fixture-fallback", params: { ...rawParams(2_000), fallbacks: "default" } },
      ],
    });
    handles.push({ label: "fallback-beta", id: withFallback.id, beta: true });
  } catch (err) {
    // The API's own validation message (about request params, never content). On
    // 1.8.0 / 2026-11-12: "The `fallbacks` parameter is not supported for batch requests."
    const apiMessage =
      err instanceof Anthropic.APIError
        ? ((err.error as { error?: { message?: string } } | undefined)?.error?.message ?? "")
        : "";
    record("(vii) batch create with server-side fallback beta", "INFO", "live", `rejected: ${errName(err)} ${apiMessage}`);
  }
  return handles;
}

async function finishBatches(client: Anthropic, handles: BatchHandle[]): Promise<void> {
  const started = Date.now();
  const pending = new Set(handles.map((h) => h.id));
  while (pending.size > 0 && Date.now() - started < BATCH_POLL_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_INTERVAL_MS));
    for (const h of handles.filter((x) => pending.has(x.id))) {
      const status = h.beta
        ? (await client.beta.messages.batches.retrieve(h.id)).processing_status
        : (await client.messages.batches.retrieve(h.id)).processing_status;
      if (status === "ended") pending.delete(h.id);
    }
    console.log(`  batches pending: ${pending.size} (${Math.round((Date.now() - started) / 1000)} s)`);
  }

  for (const h of handles) {
    const item = h.label === "plain" ? "(iii-b) enum fixture accepted, batch" : "(vii) batch request with fallback beta";
    if (pending.has(h.id)) {
      record(item, "INFO", "live", `batch pending after 30 min (${h.id})`);
      continue;
    }
    const decoder = h.beta ? await client.beta.messages.batches.results(h.id) : await client.messages.batches.results(h.id);
    for await (const entry of decoder) {
      const keys = Object.keys(entry).sort().join(",");
      if (entry.result.type !== "succeeded") {
        record(item, h.label === "plain" ? "FAIL" : "INFO", "live", `result.type=${entry.result.type} (item keys ${keys})`);
        continue;
      }
      const msg = entry.result.message;
      const usage = summarizeUsage(msg.model, msg.usage, { isBatch: true });
      spendUsd += usage.costUsd;
      const ok = msg.stop_reason === "end_turn" && fixtureValid(finalText(msg.content));
      check(
        item,
        ok,
        "live",
        `${h.id}: stop=${msg.stop_reason} zod-valid=${ok} item keys {${keys}} result keys {${Object.keys(entry.result).sort().join(",")}} cost=$${usage.costUsd.toFixed(5)}`,
      );
    }
  }
}

async function itemFourErrors(client: Anthropic): Promise<void> {
  // Live: forced tool choice is a typed 400 on Opus 5.5.
  try {
    await client.beta.messages.create({
      model: MODEL,
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "noop", description: "noop", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "tool", name: "noop" },
    });
    record("(iv-a) forced tool choice -> BadRequestError", "FAIL", "live", "call unexpectedly succeeded");
  } catch (err) {
    const classified = classifySdkError(err, "matchResumeToJob");
    check(
      "(iv-a) forced tool choice -> BadRequestError",
      err instanceof Anthropic.BadRequestError && classified instanceof ClaudeBadRequestError,
      "live",
      `${errName(err)} -> ${errName(classified)}`,
    );
  }

  // Live: an in-flight abort surfaces as APIUserAbortError straight from the SDK (no raceAbort).
  try {
    await client.beta.messages.create(rawParams(2_000), { signal: AbortSignal.timeout(300), timeout: 60_000 });
    record("(iv-b) mid-flight abort -> APIUserAbortError", "FAIL", "live", "call finished before the abort");
  } catch (err) {
    check(
      "(iv-b) mid-flight abort -> APIUserAbortError",
      err instanceof Anthropic.APIUserAbortError && classifySdkError(err, "matchResumeToJob").retryable,
      "live",
      `${errName(err)} -> ${errName(classifySdkError(err, "matchResumeToJob"))} retryable`,
    );
  }

  // Local: an already-aborted signal makes no request at all.
  const before = captured.length;
  const aborted = new AbortController();
  aborted.abort();
  try {
    await callStructured({
      task: "extractJobRequirements",
      system: [{ type: "text", text: FIXTURE_SYSTEM }],
      userContent: FIXTURE_USER,
      schema: EnumFixture,
      signal: aborted.signal,
      usageContext: { userId: null, taskId: null, taskAttempt: null },
    });
    record("(iv-c) pre-aborted signal makes no call", "FAIL", "local", "resolved");
  } catch (err) {
    check(
      "(iv-c) pre-aborted signal makes no call",
      captured.length === before && err instanceof ClaudeApiError && err.retryable,
      "local",
      `${errName(err)}, requests sent: ${captured.length - before}`,
    );
  }

  // Local: status -> class mapping and hierarchy that classifySdkError relies on.
  const expected: Array<[number, unknown, string]> = [
    [400, Anthropic.BadRequestError, "ClaudeBadRequestError"],
    [401, Anthropic.AuthenticationError, "ClaudeApiError(ai_unavailable,no-retry)"],
    [403, Anthropic.PermissionDeniedError, "ClaudeApiError(ai_unavailable,no-retry)"],
    [404, Anthropic.NotFoundError, "ClaudeBadRequestError"],
    [409, Anthropic.ConflictError, "ClaudeApiError(retry)"],
    [422, Anthropic.UnprocessableEntityError, "ClaudeBadRequestError"],
    [429, Anthropic.RateLimitError, "ClaudeApiError(retry)"],
    [500, Anthropic.InternalServerError, "ClaudeApiError(retry)"],
    [529, Anthropic.InternalServerError, "ClaudeApiError(retry)"],
  ];
  const mismatches: string[] = [];
  for (const [status, cls, want] of expected) {
    const err = Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: "x" } }, undefined, new Headers());
    const c = classifySdkError(err, "matchResumeToJob");
    const got =
      c instanceof ClaudeBadRequestError
        ? "ClaudeBadRequestError"
        : `ClaudeApiError(${c.code === "ai_unavailable" && !c.retryable ? "ai_unavailable,no-retry" : c.retryable ? "retry" : "no-retry"})`;
    if (!(err instanceof (cls as typeof Anthropic.APIError)) || got !== want) mismatches.push(`${status}:${got}`);
  }
  const hierarchyOk =
    Anthropic.APIConnectionTimeoutError.prototype instanceof Anthropic.APIConnectionError &&
    Anthropic.APIConnectionError.prototype instanceof Anthropic.APIError &&
    Anthropic.APIUserAbortError.prototype instanceof Anthropic.APIError &&
    Anthropic.APIError.prototype instanceof Anthropic.AnthropicError &&
    classifySdkError(new Anthropic.APIConnectionTimeoutError(), "matchResumeToJob").retryable &&
    classifySdkError(new Anthropic.APIConnectionError({ message: "x" }), "matchResumeToJob").retryable;
  check(
    "(iv-d) error classes, status mapping and hierarchy",
    mismatches.length === 0 && hierarchyOk,
    "local",
    mismatches.length === 0 ? `9 statuses + connection/timeout/abort hierarchy as expected` : `mismatch ${mismatches.join(" ")}`,
  );
}

async function itemsFiveSix(client: Anthropic): Promise<void> {
  // Local: without an explicit timeout the guard throws pre-send above ~21 333 tokens.
  const before = captured.length;
  try {
    await client.beta.messages.create({ ...rawParams(21_334) });
    record("(v-a) non-streaming guard without timeout", "FAIL", "local", "21 334 tokens was sent");
  } catch (err) {
    check(
      "(v-a) non-streaming guard without timeout",
      err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && captured.length === before,
      "local",
      `21 334 tokens -> ${errName(err)} pre-send (requests sent: ${captured.length - before})`,
    );
  }

  // Live: 20k with an explicit timeout makes the call. Also shows the response shape for (vi).
  try {
    const { data, request_id } = await client.beta.messages
      .create(
        { ...rawParams(20_000), betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: "default" },
        { timeout: 120_000 },
      )
      .withResponse();
    const usage = summarizeUsage(data.model, data.usage);
    spendUsd += usage.costUsd;
    check(
      "(v-b) max_tokens 20 000 + explicit timeout, non-streaming",
      data.stop_reason === "end_turn" && fixtureValid(finalText(data.content)),
      "live",
      `stop=${data.stop_reason} request_id=${request_id ? "present" : "null"} cost=$${usage.costUsd.toFixed(5)}`,
    );
    const iterations = data.usage.iterations ?? null;
    record(
      "(vi) response shape",
      "INFO",
      "live",
      `content block types=[${data.content.map((b) => b.type).join(",")}] usage keys={${Object.keys(data.usage).sort().join(",")}} iterations=${
        iterations === null ? "null" : JSON.stringify(iterations.map((it) => ({ type: it.type, model: "model" in it ? it.model : undefined })))
      } (no refusal fallback reproduced; fallback block + fallback_message iteration shapes from 1.8.0 types)`,
    );
  } catch (err) {
    record("(v-b) max_tokens 20 000 + explicit timeout, non-streaming", "FAIL", "live", errName(err));
  }
}

async function itemEightAbortBackoff(): Promise<void> {
  // Local, fake fetch: a 429 with Retry-After: 30 and maxRetries 1. If the retry
  // sleep honors the signal, the un-raced SDK promise rejects right after the abort.
  const fake = createEvalClient({
    apiKey: "sk-ant-local-fake",
    maxRetries: 1,
    fetch: (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      })) as typeof fetch,
  });
  const started = Date.now();
  try {
    await fake.messages.create(
      { model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
      { signal: AbortSignal.timeout(200), timeout: 60_000 },
    );
    record("(viii) retry backoff honors the abort signal", "FAIL", "local", "resolved");
  } catch (err) {
    const ms = Date.now() - started;
    check(
      "(viii) retry backoff honors the abort signal",
      err instanceof Anthropic.APIUserAbortError && ms < 3_000,
      "local",
      `429 + Retry-After 30 s, abort at 200 ms -> ${errName(err)} after ${ms} ms`,
    );
  }
}

async function itemNineV1Flows(): Promise<void> {
  try {
    const a = await analyzeResume(SYNTHETIC_RESUME, { userId: null });
    check(
      "(ix-a) v1 analyzeResume end-to-end (Claude half of POST /api/resumes/:id/analyze)",
      a.value.summary.length > 0 && a.value.strengths.length > 0,
      "live",
      `served=${a.model} strengths=${a.value.strengths.length} weaknesses=${a.value.weaknesses.length} roles=${a.value.suggested_roles.length} dropped=${a.dropped} cost=$${a.usage.costUsd.toFixed(4)}`,
    );
  } catch (err) {
    record("(ix-a) v1 analyzeResume end-to-end", "FAIL", "live", errName(err));
  }
  try {
    const m = await matchResumeToJob(SYNTHETIC_RESUME, SYNTHETIC_JOB, { userId: null });
    check(
      "(ix-b) v1 matchResumeToJob end-to-end (Claude half of POST /api/matches)",
      Number.isInteger(m.value.score) && m.value.score >= 0 && m.value.score <= 100 && m.value.rationale.length > 0,
      "live",
      `served=${m.model} score=${m.value.score} matched=${m.value.matched_strengths.length} gaps=${m.value.gaps.length} dropped=${m.dropped} cost=$${m.usage.costUsd.toFixed(4)}`,
    );
  } catch (err) {
    record("(ix-b) v1 matchResumeToJob end-to-end", "FAIL", "live", errName(err));
  }
}

/**
 * (x) Telemetry off (§13.5.2 "Client construction and SDK telemetry"). Local +
 * source, no network: the request below is answered by a local stub.
 */
async function itemTenTelemetryOff(): Promise<void> {
  const saved = {
    on: process.env.ANTHROPIC_OPEN_TELEMETRY,
    mode: process.env[OTEL_CONTENT_MODE_ENV],
    log: process.env.ANTHROPIC_LOG,
    key: process.env.ANTHROPIC_API_KEY,
  };
  const realDebug = console.debug;
  const realInfo = console.info;
  const restore = () => {
    console.debug = realDebug;
    console.info = realInfo;
    for (const [name, value] of [
      ["ANTHROPIC_OPEN_TELEMETRY", saved.on],
      [OTEL_CONTENT_MODE_ENV, saved.mode],
      ["ANTHROPIC_LOG", saved.log],
      ["ANTHROPIC_API_KEY", saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    __resetClaudeClientForTests();
  };

  try {
    // (x-a) env vars that would enable tracing on an option-less client are ignored.
    process.env.ANTHROPIC_OPEN_TELEMETRY = "true";
    process.env[OTEL_CONTENT_MODE_ENV] = "metadata_only";
    process.env.ANTHROPIC_LOG = "debug";
    // Never sent anywhere: every request in this item is answered by a local stub.
    process.env.ANTHROPIC_API_KEY ||= "sk-ant-local-only-x";
    __resetClaudeClientForTests();
    const client = getClaudeClient();
    check(
      "(x-f) explicit logLevel wins over ANTHROPIC_LOG=debug",
      client.logLevel === "warn",
      "local",
      `getClaudeClient().logLevel=${client.logLevel} with ANTHROPIC_LOG=debug`,
    );
    const otel = client.openTelemetry;
    check(
      "(x-a) getClaudeClient() traces disabled despite ANTHROPIC_OPEN_TELEMETRY=true",
      otel.traces.enabled === false && Object.isFrozen(otel),
      "local",
      `openTelemetry.traces.enabled=${otel.traces.enabled} contentMode=${otel.traces.contentMode} frozen=${Object.isFrozen(otel)}`,
    );

    // (x-b) no trace-context header on a request (stubbed locally, nothing sent).
    // (x-g) and no request content in console.debug/console.info despite
    // ANTHROPIC_LOG=debug, through callStructured as the app calls it.
    const SENTINEL = "SENTINEL-RESUME-TEXT-x7q";
    const calls = { debug: 0, info: 0 };
    let leaks = 0;
    const carries = (args: unknown[]) =>
      args.some((a) => {
        try {
          return (typeof a === "string" ? a : JSON.stringify(a)).includes(SENTINEL);
        } catch {
          return String(a).includes(SENTINEL);
        }
      });
    console.debug = (...args: unknown[]) => {
      calls.debug += 1;
      if (carries(args)) leaks += 1;
    };
    console.info = (...args: unknown[]) => {
      calls.info += 1;
      if (carries(args)) leaks += 1;
    };
    const before = captured.length;
    fetchOverride = (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stub" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      await callStructured({
        task: "extractJobRequirements",
        system: [{ type: "text", text: FIXTURE_SYSTEM }],
        userContent: SENTINEL,
        schema: EnumFixture,
        usageContext: { userId: null, taskId: null, taskAttempt: null },
      });
    } catch {
      // the stub's 400 is expected
    } finally {
      fetchOverride = null;
      console.debug = realDebug;
      console.info = realInfo;
    }
    check(
      "(x-g) no console.debug/console.info call carries request content with ANTHROPIC_LOG=debug",
      leaks === 0 && calls.debug === 0,
      "local",
      `console.debug calls=${calls.debug}, console.info calls=${calls.info}, carrying the request content=${leaks}`,
    );
    const sent = captured.slice(before);
    check(
      "(x-b) no traceparent/tracestate/baggage on a getClaudeClient() request",
      sent.length === 1 && sent[0].traceHeaders.length === 0,
      "local",
      `stubbed requests=${sent.length}, trace headers=[${sent.flatMap((c) => c.traceHeaders).join(",")}]`,
    );

    // (x-c) content mode fails closed before construction.
    process.env[OTEL_CONTENT_MODE_ENV] = " CONTENT ";
    __resetClaudeClientForTests();
    let thrown: unknown = null;
    try {
      getClaudeClient();
    } catch (err) {
      thrown = err;
    }
    check(
      "(x-c) content-mode guard throws ClaudeConfigurationError",
      thrown instanceof ClaudeConfigurationError,
      "local",
      `${errName(thrown)}`,
    );
  } finally {
    restore();
  }

  // (x-d) option name and semantics unchanged in the installed SDK (source).
  try {
    const sdkDir = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sdk"));
    const tracingJs = readFileSync(join(sdkDir, "internal", "tracing.js"), "utf8");
    const clientDts = readFileSync(join(sdkDir, "client.d.ts"), "utf8");
    const clientJs = readFileSync(join(sdkDir, "client.js"), "utf8");
    const facts = {
      "false is short for {traces:false}": tracingJs.includes("option === false ? { traces: false }"),
      "env read only when no option": tracingJs.includes("option ?? optionFromEnv()"),
      "no tracer when traces disabled": /function getTracer\(option[^)]*\)\s*\{\s*if \(!option\.traces\.enabled\)\s*\{\s*return undefined;/.test(tracingJs),
      "openTelemetry client option declared": /openTelemetry\?:/.test(clientDts),
      "logLevel client option declared": /logLevel\?:/.test(clientDts),
      "explicit logLevel read before ANTHROPIC_LOG":
        /parseLogLevel\)\(options\.logLevel[^;]*?\?\?\s*\(0, log_1\.parseLogLevel\)\(\(0, env_1\.readEnv\)\('ANTHROPIC_LOG'\)/.test(clientJs),
    };
    const missing = Object.entries(facts)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    check(
      "(x-d) openTelemetry / logLevel option names and env-var semantics unchanged (SDK source/types)",
      missing.length === 0,
      "source",
      missing.length === 0 ? Object.keys(facts).join("; ") : `changed: ${missing.join("; ")}`,
    );
  } catch (err) {
    record("(x-d) openTelemetry option semantics (source)", "FAIL", "source", errName(err));
  }
}

// ---- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  if (existsSync(".env.local")) loadEnvFile(".env.local");
  const onlyX = process.argv.includes("--only-x");
  // --only-x never reaches the network; item (x) supplies a placeholder key if none is set.
  if (!onlyX && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set (.env.local or environment).");
  }

  // Tally callStructured spend in memory; the DB sink is never registered here.
  setUsageSink((event) => {
    spendUsd += event.costUsd;
  });

  // Runs first (and alone with --only-x): it rebuilds the cached client under
  // different env, then restores env and resets the cache.
  await itemTenTelemetryOff();
  if (onlyX) {
    summarize();
    return;
  }

  const client = getClaudeClient();
  console.log(`SDK contract check: model ${MODEL}, expected anthropic-version ${EXPECTED_API_VERSION}\n`);

  await itemsOneToThreeSync();
  const batches = await createBatches(client);
  await itemFourErrors(client);
  await itemsFiveSix(client);
  await itemEightAbortBackoff();
  await itemNineV1Flows();
  await finishBatches(client, batches);

  const live = captured.filter((c) => !c.stubbed);
  const stubbedCount = captured.length - live.length;
  const versions = [...new Set(live.map((c) => c.version))];
  check(
    "(i) every live request carried the expected anthropic-version",
    versions.length === 1 && versions[0] === EXPECTED_API_VERSION,
    "live",
    `${live.length} live requests (${stubbedCount} stubbed excluded), versions seen: ${versions.join(",")}`,
  );
  const traced = live.filter((c) => c.traceHeaders.length > 0);
  check(
    "(x-e) no live request carried a trace-context header",
    traced.length === 0,
    "live",
    `${live.length} live requests (${stubbedCount} stubbed excluded), with trace headers: ${traced.length}`,
  );

  summarize();
}

function summarize(): void {
  const failed = results.filter((r) => r.status === "FAIL");
  console.log("\n---- summary ----");
  for (const r of results) console.log(`${r.status.padEnd(4)} ${r.how.padEnd(6)} ${r.item}`);
  console.log(`\nestimated spend: $${spendUsd.toFixed(4)} (excludes the aborted call's partial usage, if any)`);
  console.log(failed.length === 0 ? "RESULT: all checks passed" : `RESULT: ${failed.length} FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(`fatal: ${errName(err)}${err instanceof Error ? `: ${err.message}` : ""}`);
  process.exitCode = 1;
});
