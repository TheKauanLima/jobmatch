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
 *  2. Sends it through the beta Messages API with the server-side refusal
 *     fallback (`betas: ['server-side-fallback-2026-07-01']`,
 *     `fallbacks: 'default'`), with an explicit timeout and the caller's
 *     abort signal.
 *  3. Records usage (`recordUsage`) BEFORE looking at the result, so
 *     refused/truncated/invalid-but-billed calls are still counted. Priced by
 *     `response.model`.
 *  4. Classifies `stop_reason`: `refusal` -> ClaudeRefusalError, `max_tokens`
 *     -> ClaudeTruncatedError, anything but `end_turn` ->
 *     ClaudeInvalidOutputError.
 *  5. Parses the JSON text and validates it with the zod schema. Failure ->
 *     ClaudeInvalidOutputError (retryable once).
 *  6. Maps SDK errors by class, most-specific first: 400 ->
 *     ClaudeBadRequestError; 429 / 5xx / 529 / connection / timeout / abort ->
 *     ClaudeApiError(retryable). The client is built with `maxRetries: 1`;
 *     task-level retries handle the rest.
 *  7. Logs one line per call with task, model, stop_reason, token counts, and
 *     request_id only. Never prompt or response content.
 *
 * ---- Why `beta.messages.create` + our own parse, not `beta.messages.parse` ----
 * Verified against @anthropic-ai/sdk 0.122 (details in the §13.5.2
 * "Verified" note). `parse` works with `output_config.format` + `fallbacks`,
 * but (a) it throws a plain `AnthropicError` when the output fails JSON or
 * zod parsing, which discards the response (no usage, no stop_reason, so a
 * `max_tokens` truncation becomes indistinguishable from invalid output),
 * and its error message can quote model output; and (b) its result is a
 * plain Promise, so `.withResponse()` (the only way to read the request id)
 * isn't available. §13.5.2 names `create` + `schema.parse(JSON.parse(text))`
 * as the sanctioned alternative. Structured output is still enforced
 * server-side, because `zodOutputFormat(schema).schema` is sent as
 * `output_config.format`.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

import { getTaskConfig, type ClaudeTaskName } from "@/lib/claude/config";
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

let cachedClient: Anthropic | null = null;

/**
 * Lazily constructed, module-cached Anthropic client. Reads
 * `ANTHROPIC_API_KEY` on first use (not at import), so importing this module
 * never breaks a build or a route that doesn't call Claude. Throws
 * `ClaudeConfigurationError` if the key is missing.
 */
export function getClaudeClient(): Anthropic {
  if (cachedClient) {
    return cachedClient;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClaudeConfigurationError();
  }
  cachedClient = new Anthropic({ apiKey, maxRetries: CLAUDE_SDK_MAX_RETRIES });
  return cachedClient;
}

/** Test-only: reset the cached client. */
export function __resetClaudeClientForTests(): void {
  cachedClient = null;
}

/** Test-only: inject a fake client (e.g. one whose `beta.messages.create` is a mock). */
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

  // `zodOutputFormat` converts the zod schema to the JSON Schema subset that
  // structured outputs accept. Only its `schema` goes on the wire; the
  // helper's `parse` function is not used (see the module docstring).
  const format = zodOutputFormat(args.schema);

  return {
    model: config.model,
    max_tokens: config.maxTokens,
    system,
    messages: [{ role: "user", content: args.userContent }],
    output_config: {
      format: { type: "json_schema", schema: format.schema },
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
export function classifySdkError(err: unknown, task: ClaudeTaskName): ClaudeApiError {
  if (err instanceof ClaudeApiError) {
    return err;
  }

  // Client-side abort (caller's AbortSignal) and timeouts: retryable.
  if (err instanceof Anthropic.APIUserAbortError) {
    return new ClaudeApiError(`Claude call aborted (${task}).`, {
      code: "ai_unavailable",
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ClaudeApiError(`Claude call timed out (${task}).`, {
      code: "ai_unavailable",
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ClaudeApiError(`Claude connection failed (${task}).`, {
      code: "ai_unavailable",
      retryable: true,
      cause: err,
    });
  }

  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : undefined;
    const requestId = err.requestID ?? null;
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

  // Thrown by the SDK before sending (e.g. its non-streaming size guard):
  // a config bug, not transient.
  if (err instanceof Anthropic.AnthropicError) {
    return new ClaudeBadRequestError(`Claude SDK refused the request (${task}).`, { cause: err });
  }

  return new ClaudeApiError(`Claude call failed unexpectedly (${task}).`, {
    code: "ai_unavailable",
    retryable: true,
    cause: err,
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
  try {
    const { data, request_id } = await client.beta.messages
      .create(params, { signal: args.signal, timeout: config.timeoutMs })
      .withResponse();
    response = data;
    requestId = request_id ?? null;
  } catch (err) {
    const classified = classifySdkError(err, args.task);
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
