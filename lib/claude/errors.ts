/**
 * Typed Claude-layer errors, per docs/ARCHITECTURE.md §13.5.1/§13.5.2 and the
 * error-code table in §13.4.5.
 *
 * Every failure that `callStructured()` (lib/claude/client.ts) can produce is
 * one of these classes. They all extend `ClaudeApiError`, so a route handler
 * that just needs "the Claude step failed" can catch the base class, while
 * the task worker (lib/tasks/errors.ts, M1.2) can read `code` / `retryable`
 * to decide between retry, dead-letter, and user-facing copy (§13.13.9).
 *
 * ---- PII rule (reviewer-blocking) ----
 * Error messages built here contain only machine facts: the task name, HTTP
 * status, Anthropic error type, stop_reason, refusal category, zod issue
 * PATHS (schema keys/array indices, never values), and request ids. They
 * never contain prompt text, resume/job text, or response content, so route
 * handlers may log `err.message` safely. The original SDK error is kept on
 * `cause` for debugging in a debugger only; never log `cause`. SDK error
 * messages can echo parts of the API response, and the SDK's own JSON-parse
 * errors can quote the model output.
 */

/** Machine codes, matching docs/ARCHITECTURE.md §13.4.5. */
export type ClaudeErrorCode =
  | "ai_unavailable"
  | "ai_invalid_output"
  | "ai_truncated"
  | "ai_refused"
  | "ai_bad_request";

export type ClaudeErrorDetails = {
  code: ClaudeErrorCode;
  retryable: boolean;
  /** HTTP status for API errors, when there was one. */
  status?: number;
  /** Anthropic `request-id` (response header or error body), when known. */
  requestId?: string | null;
  cause?: unknown;
};

/**
 * Base class for every Claude-layer failure. Thrown directly (with
 * `code: 'ai_unavailable'`, `retryable: true`) for 429 / 5xx / 529 /
 * connection errors / timeouts / aborts, per §13.5.2 step 6.
 */
export class ClaudeApiError extends Error {
  readonly code: ClaudeErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly requestId: string | null;

  constructor(message: string, details: ClaudeErrorDetails) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ClaudeApiError";
    this.code = details.code;
    this.retryable = details.retryable;
    this.status = details.status;
    this.requestId = details.requestId ?? null;
  }
}

/**
 * `stop_reason === 'refusal'`, even after the server-side fallback. Not
 * retryable (§13.5.2 step 4). `category` is Anthropic's policy category
 * enum (`cyber`, `bio`, `frontier_llm`, `reasoning_extraction`,
 * `general_harms`, or null). It is an enum, never content, so it's safe to log.
 */
export class ClaudeRefusalError extends ClaudeApiError {
  readonly category: string | null;

  constructor(
    message: string,
    details: { category: string | null; requestId?: string | null },
  ) {
    super(message, { code: "ai_refused", retryable: false, requestId: details.requestId });
    this.name = "ClaudeRefusalError";
    this.category = details.category;
  }
}

/**
 * `stop_reason === 'max_tokens'` (or `model_context_window_exceeded`): the
 * output was cut off. Not retryable, because the same request would truncate
 * again. This is a `max_tokens` config bug to fix in lib/claude/config.ts.
 */
export class ClaudeTruncatedError extends ClaudeApiError {
  constructor(message: string, details: { requestId?: string | null } = {}) {
    super(message, { code: "ai_truncated", retryable: false, requestId: details.requestId });
    this.name = "ClaudeTruncatedError";
  }
}

/**
 * The output can't be trusted: no parseable JSON, it failed the zod schema,
 * an unexpected `stop_reason`, or semantic validation rejected it beyond
 * tolerance (§13.5.6). Retryable once (§13.5.2 step 5).
 */
export class ClaudeInvalidOutputError extends ClaudeApiError {
  constructor(message: string, details: { requestId?: string | null; cause?: unknown } = {}) {
    super(message, {
      code: "ai_invalid_output",
      retryable: true,
      requestId: details.requestId,
      cause: details.cause,
    });
    this.name = "ClaudeInvalidOutputError";
  }
}

/**
 * Anthropic rejected the request itself (HTTP 400 and other non-transient
 * 4xx), or the SDK refused to send it (e.g. its non-streaming size guard).
 * This is a config or schema bug, not retryable.
 */
export class ClaudeBadRequestError extends ClaudeApiError {
  constructor(
    message: string,
    details: { status?: number; requestId?: string | null; cause?: unknown } = {},
  ) {
    super(message, {
      code: "ai_bad_request",
      retryable: false,
      status: details.status,
      requestId: details.requestId,
      cause: details.cause,
    });
    this.name = "ClaudeBadRequestError";
  }
}

/**
 * `ANTHROPIC_API_KEY` is missing at the moment a call is attempted. Thrown
 * by `getClaudeClient()`. `callStructured()` wraps it in a non-retryable
 * `ClaudeApiError` (`ai_unavailable`), so callers only ever see one hierarchy.
 */
export class ClaudeConfigurationError extends Error {
  constructor(
    message = "ANTHROPIC_API_KEY is not configured. Set it in .env.local (see .env.local.example).",
  ) {
    super(message);
    this.name = "ClaudeConfigurationError";
  }
}
