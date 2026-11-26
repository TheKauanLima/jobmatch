/**
 * The Claude client and `callStructured()`, the single choke point for every
 * synchronous Claude call in Kalify, per docs/ARCHITECTURE.md §13.5.2.
 *
 * What one call does, in order:
 *  1. Builds params from `CLAUDE_TASKS[task]` (lib/claude/config.ts): model,
 *     max_tokens, system blocks (with `cache_control` on the last one), a
 *     single user message, and `output_config: { format, effort }`. It never
 *     sends tools, a tool-choice setting, sampling parameters, or an
 *     assistant prefill. Opus 5.5 returns 400 for a forced tool choice and
 *     for sampling parameters (verified in M1.1). client.test.ts scans this
 *     directory to keep those parameter names out of lib/claude entirely.
 *  2. Sends it through the STREAMING beta Messages API
 *     (`client.beta.messages.stream(...)`) with the server-side refusal
 *     fallback (`betas: ['server-side-fallback-2026-07-01']`,
 *     `fallbacks: 'default'`), the caller's abort signal, and the task's
 *     `timeoutMs` (passed to the SDK, and also enforced by us over the whole
 *     streamed attempt, see `raceAbort`). Then awaits `stream.finalMessage()`,
 *     the SDK-accumulated message (same shape `create` returns), and reads
 *     the request id from `stream.request_id`.
 *  3. Records usage (`recordUsage`) BEFORE looking at the result, so
 *     refused/truncated/invalid-but-billed calls are still counted. Priced by
 *     `response.model`.
 *  4. Classifies `stop_reason`: `refusal` -> ClaudeRefusalError, `max_tokens`
 *     -> ClaudeTruncatedError, anything but `end_turn` ->
 *     ClaudeInvalidOutputError.
 *  5. Parses the JSON text and validates it with the zod schema. Failure ->
 *     ClaudeInvalidOutputError (retryable once).
 *  6. Maps SDK errors by class, most-specific first: 400 ->
 *     ClaudeBadRequestError; 429 / 5xx / 529 / connection / timeout / abort /
 *     mid-stream failures -> ClaudeApiError(retryable). The client is built
 *     with `maxRetries: 1`; task-level retries handle the rest.
 *  7. Logs one line per call with task, model, stop_reason, token counts, and
 *     request_id only. Never prompt or response content.
 *
 * ---- Why streaming ----
 * A non-streaming request is silent until the whole response is ready. Some
 * networks (VPNs, proxies, NATs) close a connection that has been idle for
 * ~60 s, so long calls (critiqueResume at effort high runs well over a
 * minute) died with `APIConnectionError` (cause `UND_ERR_SOCKET: other side
 * closed`) at ~60 s. A stream sends events continuously, so the connection is
 * never idle; it is also Anthropic's recommended pattern for long requests.
 * Nothing is consumed incrementally: we only use the final message.
 *
 * Verified in the pinned @anthropic-ai/sdk 1.8.0 (lib/BetaMessageStream.js,
 * lib/beta-parser.js, core/streaming.js, client.js):
 *  - `beta.messages.stream()` is `BetaMessageStream.createMessage`, which
 *    calls the same `beta.messages.create` with `stream: true` (so `betas`,
 *    `fallbacks`, `output_config`, the timeout and the SDK retry all apply
 *    unchanged) and links our signal to the stream's own AbortController.
 *  - `stream.request_id` is the `request-id` response header, set when the
 *    headers arrive (before any event).
 *  - `finalMessage()` resolves with the snapshot accumulated from the events.
 *    `content_block_start` pushes every block as-is, `fallback` blocks
 *    included, and relabels `model` to the fallback block's `to.model`, so
 *    `finalAnswerText` and "priced by the served model" behave as with
 *    `create`. `stop_reason`, `stop_details` and `usage` come from
 *    `message_delta`.
 *  - The final message goes through `maybeParseBetaMessage`, which parses only
 *    when `output_config.format` has a `parse` function. Ours has none
 *    (lib/claude/outputFormat.ts), so the SDK never parses or throws on the
 *    output; we parse it ourselves (step 5).
 *  - The SDK's `timeout` covers only the wait for response headers (each HTTP
 *    attempt's timer is cleared once `fetch` resolves), so on its own it no
 *    longer bounds a streamed call. `raceAbort` adds a whole-attempt timer.
 *  - Errors: HTTP errors before the stream starts are the usual `APIError`
 *    subclasses; a pre-response network failure is `APIConnectionError`; an
 *    SSE `error` event is a plain `APIError` with no status; an abort is
 *    `APIUserAbortError`; any other mid-stream failure (e.g. undici's
 *    "terminated" when the socket drops) is wrapped in a plain
 *    `AnthropicError`, as are the stream's own "ended without producing a
 *    Message" errors. `classifySdkError` maps all of these.
 *
 * ---- Why our own parse, not `beta.messages.parse` (or a parsing format) ----
 * Verified against @anthropic-ai/sdk 0.122 and re-checked on the pinned
 * 1.8.0 (details in the §13.5.2 "Verified" notes). `parse` works with
 * `output_config.format` + `fallbacks`, but it throws a plain `AnthropicError`
 * when the output fails JSON or zod parsing, which discards the response (no
 * usage, no stop_reason, so a `max_tokens` truncation becomes
 * indistinguishable from invalid output), and its error message can quote
 * model output. A stream whose format carries a `parse` function would do the
 * same. §13.5.2 names `schema.parse(JSON.parse(text))` as the sanctioned
 * approach. Structured output is still enforced server-side, because
 * `buildOutputFormat(schema)` (lib/claude/outputFormat.ts, a pass-through over
 * the SDK's zod helper) is sent as `output_config.format`.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

import { getTaskConfig, type ClaudeTaskName } from "@/lib/claude/config";
import { buildOutputFormat } from "@/lib/claude/outputFormat";
import {
  ClaudeApiError,
  ClaudeBadRequestError,
  ClaudeConfigurationError,
  ClaudeInvalidOutputError,
  ClaudeRefusalError,
  ClaudeTruncatedError,
} from "@/lib/claude/errors";
import { recordUsage, summarizeUsage, type UsageSummary } from "@/lib/claude/usage";

// Re-exported so existing `@/lib/claude/client` imports keep working
// (§13.5.1 lists "ClaudeApiError & subclasses" under client.ts).
export {
  ClaudeApiError,
  ClaudeBadRequestError,
  ClaudeConfigurationError,
  ClaudeInvalidOutputError,
  ClaudeRefusalError,
  ClaudeTruncatedError,
} from "@/lib/claude/errors";

/** Server-side refusal fallback (Opus 5.5). Verified working with structured outputs in M1.1. */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** SDK-level automatic retries for transient errors (§13.5.2 step 6). */
export const CLAUDE_SDK_MAX_RETRIES = 1;

/**
 * The SDK env var that, on a client built without a telemetry option, puts
 * prompt and response text into trace spans. Our client ignores it
 * (`openTelemetry: false`), but its presence means someone intends content
 * capture, so `getClaudeClient()` fails closed (§13.5.2 "Client construction
 * and SDK telemetry" item 2).
 */
export const OTEL_CONTENT_MODE_ENV = "ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE";

/**
 * The SDK log level, set explicitly so `ANTHROPIC_LOG=debug` can't make the
 * SDK log request bodies (see `getClaudeClient`). Never `info` or `debug`.
 */
export const CLAUDE_SDK_LOG_LEVEL = "warn" as const;

type SdkLogger = NonNullable<NonNullable<ConstructorParameters<typeof Anthropic>[0]>["logger"]>;

/** Forwards only the SDK's fixed message string; drops data args, which on the
 *  streaming path can carry response content (core/streaming.js ~l.65). */
export const CLAUDE_SDK_LOGGER: SdkLogger = {
  error: (message: string) => console.error(`[anthropic-sdk] ${message}`),
  warn: (message: string) => console.warn(`[anthropic-sdk] ${message}`),
  info: () => {},
  debug: () => {},
};

let cachedClient: Anthropic | null = null;

/**
 * Lazily constructed, module-cached Anthropic client, and the ONLY place app
 * code constructs one (a grep test in client.test.ts enforces this). Reads
 * env on first use (not at import), so importing this module never breaks a
 * build or a route that doesn't call Claude.
 *
 * Throws `ClaudeConfigurationError` (which `callStructured` maps to a
 * non-retryable `ai_unavailable`) if:
 *  - `ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE` is `content` (trimmed,
 *    any case). The message names the variable only, never its value;
 *  - `ANTHROPIC_API_KEY` is missing.
 *
 * `openTelemetry: false` turns off the SDK's built-in OpenTelemetry tracing
 * (on by default since 1.x). Verified in the 1.8.0 runtime
 * (`internal/tracing.js`):
 *  - `resolveOpenTelemetryOptions(false)` becomes `{ traces: false }`, and the
 *    `ANTHROPIC_OPEN_TELEMETRY*` env vars are read only when no option is given;
 *  - `getTracer` then returns `undefined`, so every request takes the
 *    untraced `makeRequest` path;
 *  - with no span, no `traceparent` / `tracestate` / `baggage` header is
 *    injected.
 * Resume text must never reach a tracing backend (§13.2.1 rule 5).
 *
 * `logLevel: CLAUDE_SDK_LOG_LEVEL` ("warn") is explicit so the SDK never reads
 * `ANTHROPIC_LOG`. At `debug`, 1.8.0's `debugLogRequestDetails` writes every
 * request body (prompts, i.e. resume text) to `console.debug`, which ends up in
 * the platform's logs. Verified in the 1.8.0 runtime (`client.js` constructor):
 * `parseLogLevel(options.logLevel) ?? parseLogLevel(env ANTHROPIC_LOG) ?? default`,
 * so a valid explicit option always wins.
 *
 * `logger: CLAUDE_SDK_LOGGER` covers what `warn` still lets through. The SDK
 * calls `logger.error(message, ...data)`, and on the streaming path the data
 * can be response content: on a malformed SSE event, 1.8.0's
 * `core/streaming.js` (~l.65-66) logs `("Could not parse message into JSON:",
 * sse.data)` and `("From chunk:", sse.raw)` via `loggerFor(client)`, i.e.
 * this logger. The model output is resume-derived. `CLAUDE_SDK_LOGGER`
 * forwards only the first argument (the SDK's fixed message string) at
 * error/warn and drops every later argument; info/debug are no-ops.
 */
export function getClaudeClient(): Anthropic {
  if (cachedClient) {
    return cachedClient;
  }
  if (process.env[OTEL_CONTENT_MODE_ENV]?.trim().toLowerCase() === "content") {
    throw new ClaudeConfigurationError(
      `${OTEL_CONTENT_MODE_ENV} is set to a mode that is not allowed for Claude calls. Unset it.`,
    );
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClaudeConfigurationError();
  }
  cachedClient = new Anthropic({
    apiKey,
    maxRetries: CLAUDE_SDK_MAX_RETRIES,
    openTelemetry: false,
    logLevel: CLAUDE_SDK_LOG_LEVEL,
    logger: CLAUDE_SDK_LOGGER,
  });
  return cachedClient;
}

/** Test-only: reset the cached client. */
export function __resetClaudeClientForTests(): void {
  cachedClient = null;
}

/** Test-only: inject a fake client (e.g. one whose `beta.messages.stream` is a mock). */
export function __setClaudeClientForTests(client: Anthropic | null): void {
  cachedClient = client;
}

export type UsageContext = {
  userId: string | null;
  taskId: string | null;
  taskAttempt: number | null;
};

export type CallStructuredArgs<T> = {
  /** Key into `CLAUDE_TASKS`. */
  task: ClaudeTaskName;
  /** Stable system blocks. `callStructured` puts `cache_control` on the last one. */
  system: Anthropic.TextBlockParam[];
  /** Volatile per-call content, already built with `wrapUntrusted`. */
  userContent: string;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  usageContext: UsageContext;
};

export type CallStructuredResult<T> = {
  value: T;
  /** The model that actually served the response (may differ if the refusal fallback fired). */
  model: string;
  stopReason: string;
  usage: UsageSummary;
  requestId: string | null;
};

type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/**
 * Builds the exact request body for a task. Exported (pure) so tests can
 * assert on it, e.g. that no forbidden params are ever sent.
 */
export function buildStructuredParams<T>(
  args: Pick<CallStructuredArgs<T>, "task" | "system" | "userContent" | "schema">,
): BetaCreateParams {
  const config = getTaskConfig(args.task);

  if (args.system.length === 0) {
    throw new Error("callStructured requires at least one system block.");
  }

  // Strip any caller-provided cache_control and set it on the LAST stable
  // block only (§13.5.3), so cache breakpoints are uniform across tasks.
  const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = args.system.map((block, i) => {
    const { cache_control: _ignored, ...rest } = block;
    void _ignored;
    return i === args.system.length - 1
      ? { ...rest, cache_control: { type: "ephemeral" as const } }
      : rest;
  });

  return {
    model: config.model,
    max_tokens: config.maxTokens,
    system,
    messages: [{ role: "user", content: args.userContent }],
    output_config: {
      // The single wire-schema seam, shared with the batch builder (§13.5.2).
      format: buildOutputFormat(args.schema),
      effort: config.effort,
    },
    betas: [SERVER_SIDE_FALLBACK_BETA],
    fallbacks: "default",
  };
}

/**
 * Text of the final answer. When the refusal fallback fires, `content` can
 * hold a partial answer from the declined model, then a `fallback` boundary
 * block, then the serving model's answer, so we read only the text after the
 * last boundary.
 */
function finalAnswerText(content: Anthropic.Beta.Messages.BetaContentBlock[]): string | null {
  let start = 0;
  content.forEach((block, i) => {
    if (block.type === "fallback") {
      start = i + 1;
    }
  });
  const texts = content
    .slice(start)
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text);
  return texts.length > 0 ? texts.join("") : null;
}

/** zod issue paths only (schema keys / indices). Never values or messages. */
function describeIssuePaths(error: z.ZodError): string {
  const paths = error.issues.slice(0, 5).map((issue) => issue.path.join(".") || "(root)");
  const more = error.issues.length > 5 ? ` +${error.issues.length - 5} more` : "";
  return `${paths.join(", ")}${more}`;
}

function logCall(entry: Record<string, unknown>, level: "info" | "warn" = "info"): void {
  const line = `[claude] ${JSON.stringify(entry)}`;
  if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

/**
 * Maps anything thrown by the SDK call to the Claude error hierarchy.
 * Uses typed SDK classes, most specific first. Never string-matches messages,
 * and never copies the SDK message (it can echo API response text).
 */
export function classifySdkError(
  err: unknown,
  task: ClaudeTaskName,
  /** The stream's request id, if headers had arrived. Used when the error carries none. */
  streamRequestId: string | null = null,
): ClaudeApiError {
  if (err instanceof ClaudeApiError) {
    return err;
  }

  // Client-side abort (caller's AbortSignal) and timeouts: retryable.
  if (err instanceof Anthropic.APIUserAbortError) {
    return new ClaudeApiError(`Claude call aborted (${task}).`, {
      code: "ai_unavailable",
      retryable: true,
      requestId: streamRequestId,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ClaudeApiError(`Claude call timed out (${task}).`, {
      code: "ai_unavailable",
      retryable: true,
      requestId: streamRequestId,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ClaudeApiError(`Claude connection failed (${task}).`, {
      code: "ai_unavailable",
      retryable: true,
      requestId: streamRequestId,
      cause: err,
    });
  }

  if (err instanceof Anthropic.APIError) {
    // Includes a mid-stream SSE `error` event: a plain APIError with no
    // status, which falls through to the retryable default below.
    const status = typeof err.status === "number" ? err.status : undefined;
    const requestId = err.requestID ?? streamRequestId;
    const where = `(${task}, status ${status ?? "none"}, request ${requestId ?? "unknown"})`;

    if (err instanceof Anthropic.BadRequestError) {
      return new ClaudeBadRequestError(`Claude rejected the request ${where}.`, {
        status,
        requestId,
        cause: err,
      });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return new ClaudeApiError(`Claude rate limited ${where}.`, {
        code: "ai_unavailable",
        retryable: true,
        status,
        requestId,
        cause: err,
      });
    }
    if (err instanceof Anthropic.InternalServerError) {
      // >= 500, including 529 overloaded.
      return new ClaudeApiError(`Claude unavailable ${where}.`, {
        code: "ai_unavailable",
        retryable: true,
        status,
        requestId,
        cause: err,
      });
    }
    if (
      err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError
    ) {
      // Bad or unauthorized key: an operator problem, and retrying won't help.
      return new ClaudeApiError(`Claude authentication failed ${where}.`, {
        code: "ai_unavailable",
        retryable: false,
        status,
        requestId,
        cause: err,
      });
    }
    if (err instanceof Anthropic.ConflictError || status === 408) {
      // Transient by definition. The SDK retries these too.
      return new ClaudeApiError(`Claude transient error ${where}.`, {
        code: "ai_unavailable",
        retryable: true,
        status,
        requestId,
        cause: err,
      });
    }
    if (status !== undefined && status >= 400 && status < 500) {
      // 404 (unknown model), 413 (too large), 422, ...: the request is wrong.
      return new ClaudeBadRequestError(`Claude rejected the request ${where}.`, {
        status,
        requestId,
        cause: err,
      });
    }
    return new ClaudeApiError(`Claude API error ${where}.`, {
      code: "ai_unavailable",
      retryable: true,
      status,
      requestId,
      cause: err,
    });
  }

  // A plain AnthropicError on the streaming path is a stream failure: the
  // SDK wraps any non-SDK error thrown while reading the body (e.g. undici's
  // "terminated" when the socket drops mid-stream) in one, and throws its own
  // for a stream that ends early ("stream ended without producing a
  // Message", "request ended without sending any chunks"). Transient. (The
  // SDK's pre-send non-streaming size guard, the old reason to treat this as
  // a bad request, does not apply to streams.)
  if (err instanceof Anthropic.AnthropicError) {
    return new ClaudeApiError(`Claude stream failed (${task}, request ${streamRequestId ?? "unknown"}).`, {
      code: "ai_unavailable",
      retryable: true,
      requestId: streamRequestId,
      cause: err,
    });
  }

  return new ClaudeApiError(`Claude call failed unexpectedly (${task}).`, {
    code: "ai_unavailable",
    retryable: true,
    requestId: streamRequestId,
    cause: err,
  });
}

/**
 * Settles with `promise`, or rejects with `APIUserAbortError` as soon as
 * `signal` fires, whichever comes first.
 *
 * The SDK forwards `signal` to fetch, but it only checks `signal.aborted`
 * at certain points: before each attempt, and when the request fails with a
 * connection-level error. Between attempts:
 *  - SDK 0.122's retry backoff was a plain `sleep()` that ignored the signal,
 *    so an abort waited out the whole backoff;
 *  - SDK 1.8.0 honors it: `retryRequest` (client.js) calls
 *    `sleep(ms, options.signal)` (internal/utils/sleep.js), which resolves early
 *    on abort, and the next attempt's `signal.aborted` check throws
 *    `APIUserAbortError` (contract-check item (viii)).
 * The race stays anyway. Our hard deadline must not depend on SDK internals
 * that have already changed once, and the SDK still honors `Retry-After` with
 * no cap of its own (anything up to 2^31-1 ms). The abandoned SDK promise is
 * still observed, so it can't become an unhandled rejection.
 *
 * Streaming adds a second bound: `timeoutMs`. The SDK's own `timeout` only
 * covers the wait for response headers, so after `timeoutMs` this rejects
 * with `APIConnectionTimeoutError`, keeping the task timeout a bound on the
 * whole attempt (as it was for a non-streaming call). On either expiry
 * `onAbandon` runs (callStructured passes `stream.abort()`), so the socket is
 * released rather than left streaming into nothing.
 */
function raceAbort<R>(
  promise: Promise<R>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onAbandon: () => void,
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      return true;
    };
    const abandon = (err: Error) => {
      if (!finish()) return;
      try {
        onAbandon();
      } catch {
        // Tearing down is best effort; the rejection below is what matters.
      }
      reject(err);
    };
    const onAbort = () => abandon(new Anthropic.APIUserAbortError());
    const timer = setTimeout(() => abandon(new Anthropic.APIConnectionTimeoutError()), timeoutMs);
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(
      (value) => {
        if (finish()) resolve(value);
      },
      (err: unknown) => {
        if (finish()) reject(err);
      },
    );
  });
}

/**
 * The single choke point for synchronous Claude calls (§13.5.2). See the
 * module docstring for the exact behavior. Always resolves to a
 * schema-validated `value` or throws a `ClaudeApiError` subclass.
 */
export async function callStructured<T>(
  args: CallStructuredArgs<T>,
): Promise<CallStructuredResult<T>> {
  const config = getTaskConfig(args.task);

  let client: Anthropic;
  try {
    client = getClaudeClient();
  } catch (err) {
    throw new ClaudeApiError(`Claude client is not configured (${args.task}).`, {
      code: "ai_unavailable",
      retryable: false,
      cause: err,
    });
  }

  const params = buildStructuredParams(args);

  let response: Anthropic.Beta.Messages.BetaMessage;
  let requestId: string | null;
  let stream: ReturnType<typeof client.beta.messages.stream> | null = null;
  try {
    // Deadline already passed (e.g. retryOnceOnInvalidOutput after the
    // deadline fired): don't start a call that can't finish.
    if (args.signal?.aborted) {
      throw new Anthropic.APIUserAbortError();
    }
    const started = client.beta.messages.stream(params, {
      signal: args.signal,
      timeout: config.timeoutMs,
    });
    stream = started;
    response = await raceAbort(started.finalMessage(), args.signal, config.timeoutMs, () =>
      started.abort(),
    );
    requestId = started.request_id ?? null;
  } catch (err) {
    const classified = classifySdkError(err, args.task, stream?.request_id ?? null);
    logCall(
      {
        task: args.task,
        model: config.model,
        error: classified.code,
        status: classified.status ?? null,
        request_id: classified.requestId,
      },
      "warn",
    );
    throw classified;
  }

  // ---- Step 3: record usage before inspecting the result ----
  const servedModel = response.model;
  const usage = summarizeUsage(servedModel, response.usage);
  const stopReason = response.stop_reason ?? "unknown";

  await recordUsage({
    provider: "anthropic",
    operation: args.task,
    model: servedModel,
    isBatch: false,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costUsd: usage.costUsd,
    stopReason,
    requestId,
    userId: args.usageContext.userId,
    taskId: args.usageContext.taskId,
    taskAttempt: args.usageContext.taskAttempt,
  });

  const logEntry = {
    task: args.task,
    model: servedModel,
    stop_reason: stopReason,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    request_id: requestId,
  };

  if (!usage.priceKnown) {
    logCall({ ...logEntry, warning: "no price for served model; priced conservatively" }, "warn");
  }

  // ---- Step 4: stop_reason ----
  if (stopReason === "refusal") {
    const category = response.stop_details?.category ?? null;
    logCall({ ...logEntry, refusal_category: category }, "warn");
    throw new ClaudeRefusalError(
      `Claude declined the request (${args.task}, category ${category ?? "none"}, request ${requestId ?? "unknown"}).`,
      { category, requestId },
    );
  }
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
    logCall(logEntry, "warn");
    throw new ClaudeTruncatedError(
      `Claude output was truncated (${args.task}, stop_reason ${stopReason}, max_tokens ${config.maxTokens}, request ${requestId ?? "unknown"}).`,
      { requestId },
    );
  }
  if (stopReason !== "end_turn") {
    logCall(logEntry, "warn");
    throw new ClaudeInvalidOutputError(
      `Unexpected Claude stop_reason (${args.task}, ${stopReason}, request ${requestId ?? "unknown"}).`,
      { requestId },
    );
  }

  // ---- Step 5: parse + schema-validate ----
  const text = finalAnswerText(response.content);
  let parsed: T | null = null;
  let failure = "no text block";

  if (text !== null) {
    let json: unknown;
    let jsonOk = true;
    try {
      json = JSON.parse(text);
    } catch {
      // The JSON.parse message can quote the output, so it is deliberately dropped.
      jsonOk = false;
      failure = "not valid JSON";
    }
    if (jsonOk) {
      const result = args.schema.safeParse(json);
      if (result.success) {
        parsed = result.data;
      } else {
        failure = `schema mismatch at ${describeIssuePaths(result.error)}`;
      }
    }
  }

  if (parsed === null) {
    logCall({ ...logEntry, error: "ai_invalid_output" }, "warn");
    throw new ClaudeInvalidOutputError(
      `Claude output failed validation (${args.task}: ${failure}, request ${requestId ?? "unknown"}).`,
      { requestId },
    );
  }

  logCall(logEntry);

  return { value: parsed, model: servedModel, stopReason, usage, requestId };
}

/**
 * Runs `fn` and retries it exactly once if it throws
 * `ClaudeInvalidOutputError` (§13.5.2: "a single task-level retry on
 * ai_invalid_output"). For synchronous request paths that have no task
 * worker to do the retry (the v1 analyze/match routes). Worker handlers rely
 * on the worker's retry policy instead and must not use this. Every attempt
 * records its own usage.
 */
export async function retryOnceOnInvalidOutput<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ClaudeInvalidOutputError) {
      return fn();
    }
    throw err;
  }
}
