/**
 * Task error codes, classification, message sanitizing, and retry backoff
 * (docs/ARCHITECTURE.md §13.4.5).
 *
 * PII rule (§13.15 item 7): `last_error_message` must never contain resume,
 * listing or fetched-page text. So only messages that task code authored
 * deliberately (`TaskError`) are persisted. For any other thrown value,
 * only its class name is kept; its `message` is discarded, because library
 * error messages can echo input (validation errors, HTTP bodies, ...).
 */

export const TASK_ERROR_CODES = [
  "ai_unavailable",
  "ai_invalid_output",
  "ai_truncated",
  "ai_refused",
  "ai_bad_request",
  "embed_unavailable",
  "text_extraction_failed",
  "not_a_resume",
  "not_a_job_posting",
  "fetch_blocked",
  "fetch_failed",
  "site_not_supported",
  "source_unavailable",
  "ownership_mismatch",
  "unknown_payload",
  "budget_exhausted",
  "lease_expired",
  "internal_error",
] as const;

export type TaskErrorCode = (typeof TASK_ERROR_CODES)[number];

/**
 * Default retryability per code (§13.4.5 table). `ai_invalid_output` is
 * "yes, once more, then dead" — see `classifyTaskError`. `budget_exhausted`
 * never reaches `fail_task`: the worker turns it into a snooze.
 * `lease_expired` is set only by `claim_tasks` in SQL.
 */
export const DEFAULT_RETRYABLE: Record<TaskErrorCode, boolean> = {
  ai_unavailable: true,
  ai_invalid_output: true,
  ai_truncated: false,
  ai_refused: false,
  ai_bad_request: false,
  embed_unavailable: true,
  text_extraction_failed: false,
  not_a_resume: false,
  not_a_job_posting: false,
  fetch_blocked: false,
  fetch_failed: true,
  site_not_supported: false,
  source_unavailable: true,
  ownership_mismatch: false,
  unknown_payload: false,
  budget_exhausted: false,
  lease_expired: false,
  internal_error: true,
};

export function isTaskErrorCode(value: unknown): value is TaskErrorCode {
  return (
    typeof value === "string" &&
    (TASK_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * The error handlers throw (§13.4.3). `message` is persisted to
 * `background_tasks.last_error_message` (after sanitizing), so it must be
 * written by the developer and must never interpolate resume/listing text
 * or any user data. Ids are fine.
 */
export class TaskError extends Error {
  readonly code: TaskErrorCode;
  readonly retryable: boolean;

  constructor(
    code: TaskErrorCode,
    message?: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message ?? code, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TaskError";
    this.code = code;
    this.retryable = options?.retryable ?? DEFAULT_RETRYABLE[code];
  }
}

export const MAX_ERROR_MESSAGE_LENGTH = 500;

/** Strips control characters, collapses whitespace, truncates to 500. */
export function sanitizeErrorMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const cleaned = message
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_ERROR_MESSAGE_LENGTH
    ? cleaned.slice(0, MAX_ERROR_MESSAGE_LENGTH)
    : cleaned;
}

/** A class name that is safe to persist/log (identifier-shaped). */
export function safeErrorName(err: unknown): string {
  const name =
    err && typeof err === "object" && "name" in err
      ? (err as { name?: unknown }).name
      : undefined;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(name)
    ? name
    : "Error";
}

/**
 * Claude layer error names, fixed by docs/ARCHITECTURE.md §13.5.1
 * (`lib/claude/errors.ts` / `client.ts`). Matched by `name` rather than by
 * `instanceof` so this module doesn't import `lib/claude` (keeps the task
 * core free of the SDK). Handlers may also catch these themselves and throw
 * a `TaskError` explicitly, which always takes precedence.
 */
const CLAUDE_ERROR_CODES: Record<string, TaskErrorCode> = {
  ClaudeRefusalError: "ai_refused",
  ClaudeTruncatedError: "ai_truncated",
  ClaudeInvalidOutputError: "ai_invalid_output",
  ClaudeBadRequestError: "ai_bad_request",
};

export interface ClassifiedError {
  code: TaskErrorCode;
  retryable: boolean;
  /** Sanitized; safe to persist. */
  message: string | null;
}

/**
 * Maps anything a handler threw to a code + retryability + safe message.
 *
 * @param previousErrorCode the claimed row's `last_error_code`, i.e. the
 *   outcome of the previous attempt. Implements "ai_invalid_output:
 *   retryable once more, then dead": two invalid outputs in a row are final.
 * @param timedOut whether the task's `signal` had fired (deadline reached).
 */
export function classifyTaskError(
  err: unknown,
  context: { previousErrorCode: string | null; timedOut: boolean },
): ClassifiedError {
  let code: TaskErrorCode;
  let retryable: boolean;
  let message: string | null;

  if (err instanceof TaskError) {
    code = err.code;
    retryable = err.retryable;
    message = sanitizeErrorMessage(err.message);
  } else {
    const name = safeErrorName(err);
    const claudeCode = CLAUDE_ERROR_CODES[name];

    if (claudeCode) {
      code = claudeCode;
      retryable = DEFAULT_RETRYABLE[claudeCode];
      message = `Unhandled ${name}`;
    } else if (name === "ClaudeApiError") {
      // §13.5.2 step 6: 429/5xx/529/network/abort carry retryable: true.
      // A ClaudeApiError explicitly flagged non-retryable (e.g. auth/config)
      // is treated like a bad request.
      const flagged = (err as { retryable?: unknown }).retryable;
      code = flagged === false ? "ai_bad_request" : "ai_unavailable";
      retryable = flagged !== false;
      message = `Unhandled ${name}`;
    } else {
      code = "internal_error";
      retryable = true;
      message = context.timedOut
        ? "Task exceeded its time budget (maxDurationMs)."
        : `Unhandled ${name}`;
    }
  }

  if (code === "ai_invalid_output" && context.previousErrorCode === "ai_invalid_output") {
    retryable = false;
  }

  return { code, retryable, message };
}

export const BACKOFF_BASE_SECONDS = 30;
export const BACKOFF_FACTOR = 4;
export const BACKOFF_MAX_SECONDS = 3600;

/**
 * `min(30 × 4^(attempts−1), 3600) × random(0.8–1.2)` seconds (§13.4.5):
 * about 30 s, 2 m, 8 m, 32 m, 60 m. `attempts` is the attempt that just
 * failed (1-based, as stored after the claim incremented it).
 */
export function computeBackoffSeconds(
  attempts: number,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempts));
  const base = Math.min(
    BACKOFF_BASE_SECONDS * Math.pow(BACKOFF_FACTOR, n - 1),
    BACKOFF_MAX_SECONDS,
  );
  const jitter = 0.8 + 0.4 * clamp01(random());
  return Math.max(1, Math.round(base * jitter));
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(1, Math.max(0, x));
}
