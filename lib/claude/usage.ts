/**
 * Claude cost accounting, per docs/ARCHITECTURE.md §13.5.1, §13.5.2 step 3,
 * §13.3.1 (`ai_usage_events`) and §13.17 (prices).
 *
 * - `PRICES` / `costFromUsage()`: pure USD cost math from an API `usage`
 *   object. Pricing uses the model that actually served the response
 *   (`response.model`), not the requested one, because the server-side refusal
 *   fallback can serve a different model.
 * - `recordUsage()`: hands one `UsageEvent` per billed API response to a
 *   pluggable sink. The default sink is a no-op. M1.2 registers the database
 *   sink (`ai_usage_events` insert via the service-role client) with
 *   `setUsageSink()`. This module deliberately has no Supabase dependency.
 *
 * PII: a `UsageEvent` holds ids, enums, token counts, and money only. Never
 * add prompt/response text or anything derived from it (§13.15 item 7).
 */

/** USD per million tokens. */
export type ModelPrice = {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
};

/**
 * Prices as stated 2026-11-04 (§13.17). Thinking tokens are billed as
 * output and are already included in `usage.output_tokens`.
 * Keys are matched as exact ids or as a prefix (dated snapshots such as
 * `claude-opus-5-5-YYYYMMDD` price like their alias).
 */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
};

/**
 * Prompt-caching multipliers on the input price (Anthropic's standard
 * schedule): 5-minute cache writes cost 1.25x input, 1-hour writes 2x, and
 * cache reads 0.1x. `usage.input_tokens` excludes cached tokens, so the three
 * are additive.
 */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;
export const CACHE_READ_MULTIPLIER = 0.1;

/** Message Batches are billed at 50% (§13.17). */
export const BATCH_DISCOUNT = 0.5;

/**
 * Used when the serving model isn't in `PRICES` (e.g. an unannounced
 * fallback model). We price at the most expensive known rate so the global
 * spend guard (§13.9.4) over-counts rather than under-counts, and we log a
 * warning (model id only) so someone adds the price.
 */
const MOST_EXPENSIVE_PRICE: ModelPrice = Object.values(PRICES).reduce((max, p) =>
  p.outputPerMTok > max.outputPerMTok ? p : max,
);

/**
 * The subset of the SDK's (beta) `Usage` shape this module reads. Declared
 * structurally so both `Anthropic.Usage` and `Anthropic.Beta.BetaUsage`
 * (and test fixtures) fit without casts.
 */
export type UsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
  /**
   * Per-iteration breakdown. When the server-side fallback serves a request
   * there is one `message` entry for the declined hop and one
   * `fallback_message` entry for the serving model, each with its own
   * model. Observed live on Opus 5.5: entries can carry `model: null`,
   * meaning "the response model".
   */
  iterations?: ReadonlyArray<{
    type: string;
    model?: string | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: UsageLike["cache_creation"];
  }> | null;
};

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** Normalized usage returned by `callStructured()`. */
export type UsageSummary = TokenCounts & {
  costUsd: number;
  /** False when the serving model had no entry in `PRICES` (cost is a conservative estimate). */
  priceKnown: boolean;
};

export function lookupPrice(model: string): ModelPrice | null {
  if (PRICES[model]) {
    return PRICES[model];
  }
  // Longest matching prefix, so a dated snapshot id still prices correctly.
  const key = Object.keys(PRICES)
    .filter((k) => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? PRICES[key] : null;
}

function n(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

type PricedPart = {
  model: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: UsageLike["cache_creation"];
};

function costOfPart(part: PricedPart): { cost: number; known: boolean } {
  const price = lookupPrice(part.model);
  const p = price ?? MOST_EXPENSIVE_PRICE;

  const cacheWriteTotal = n(part.cache_creation_input_tokens);
  const write1h = Math.min(n(part.cache_creation?.ephemeral_1h_input_tokens), cacheWriteTotal);
  const write5m = cacheWriteTotal - write1h; // unspecified TTL is treated as 5m (the default)

  const inputUsd =
    (n(part.input_tokens) +
      write5m * CACHE_WRITE_5M_MULTIPLIER +
      write1h * CACHE_WRITE_1H_MULTIPLIER +
      n(part.cache_read_input_tokens) * CACHE_READ_MULTIPLIER) *
    (p.inputPerMTok / 1_000_000);
  const outputUsd = n(part.output_tokens) * (p.outputPerMTok / 1_000_000);

  return { cost: inputUsd + outputUsd, known: price !== null };
}

/** Rounds to `numeric(12,6)` precision (the `ai_usage_events.cost_usd` column type). */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * USD cost of one API response.
 *
 * If `usage.iterations` lists more than one sampling hop (the refusal
 * fallback case), each hop is priced at its own model, because a declined
 * Opus hop and the serving fallback hop have different rates. Otherwise the
 * top-level counts are priced at `model` (the response model).
 */
export function costFromUsage(
  model: string,
  usage: UsageLike,
  opts: { isBatch?: boolean } = {},
): { costUsd: number; priceKnown: boolean } {
  const hops = (usage.iterations ?? []).filter(
    (it) => it.type === "message" || it.type === "fallback_message",
  );

  let total = 0;
  let known = true;

  if (hops.length > 1) {
    for (const hop of hops) {
      const { cost, known: k } = costOfPart({ ...hop, model: hop.model ?? model });
      total += cost;
      known &&= k;
    }
  } else {
    const { cost, known: k } = costOfPart({ ...usage, model });
    total = cost;
    known = k;
  }

  if (opts.isBatch) {
    total *= BATCH_DISCOUNT;
  }

  return { costUsd: roundUsd(total), priceKnown: known };
}

export function tokenCountsFromUsage(usage: UsageLike): TokenCounts {
  return {
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cacheReadTokens: n(usage.cache_read_input_tokens),
    cacheWriteTokens: n(usage.cache_creation_input_tokens),
  };
}

export function summarizeUsage(
  model: string,
  usage: UsageLike,
  opts: { isBatch?: boolean } = {},
): UsageSummary {
  return { ...tokenCountsFromUsage(usage), ...costFromUsage(model, usage, opts) };
}

// ---------------------------------------------------------------------------
// Usage sink (no-op until M1.2 wires `ai_usage_events`)
// ---------------------------------------------------------------------------

/**
 * One row's worth of `ai_usage_events` (§13.3.1), camelCased. M1.2's sink
 * maps this 1:1 onto the table columns.
 */
export type UsageEvent = {
  provider: "anthropic";
  /** Claude task name (`ClaudeTaskName`), stored in `ai_usage_events.operation`. */
  operation: string;
  /** The model that actually served the response (`response.model`). */
  model: string;
  isBatch: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  stopReason: string | null;
  requestId: string | null;
  userId: string | null;
  taskId: string | null;
  taskAttempt: number | null;
};

export type UsageSink = (event: UsageEvent) => void | Promise<void>;

const noopSink: UsageSink = () => {};

/**
 * The sink lives on `globalThis` under a registry symbol, not in a module
 * variable. Next.js can bundle this module into more than one server chunk
 * (one per route), and some loaders create separate module instances. A
 * module-local variable would then make a sink registered from one entry
 * point invisible to Claude calls made through another copy. This was
 * observed during M1.1's manual check. The symbol makes registration
 * process-wide.
 */
const SINK_KEY = Symbol.for("kalify.claude.usageSink");
type SinkHolder = { [SINK_KEY]?: UsageSink };

function getSink(): UsageSink {
  return (globalThis as SinkHolder)[SINK_KEY] ?? noopSink;
}

/**
 * Registers the process-wide usage sink. Pass `null` to restore the no-op
 * default (tests). M1.2 calls this with an `ai_usage_events` writer from a
 * module that every Claude-calling server entry point imports, so it has
 * run before the first call in each serverless instance.
 */
export function setUsageSink(sink: UsageSink | null): void {
  (globalThis as SinkHolder)[SINK_KEY] = sink ?? noopSink;
}

/**
 * Records one billed API response. Awaited by `callStructured()` before the
 * result is inspected (§13.5.2 step 3), so failed-but-billed calls are
 * counted.
 *
 * Never throws: a broken sink must not turn a successful (and already paid
 * for) Claude call into a user-facing failure. Sink errors are logged
 * without the event payload's content (there is no content to leak, but the
 * log stays minimal anyway).
 */
export async function recordUsage(event: UsageEvent): Promise<void> {
  try {
    await getSink()(event);
  } catch (err) {
    console.error(
      "[claude.usage] usage sink failed:",
      JSON.stringify({
        operation: event.operation,
        model: event.model,
        request_id: event.requestId,
        error: err instanceof Error ? err.name : "unknown",
      }),
    );
  }
}
