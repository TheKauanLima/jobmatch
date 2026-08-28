/**
 * Anthropic SDK client instantiation, per docs/ARCHITECTURE.md §3.
 *
 * The client reads `ANTHROPIC_API_KEY` from the environment lazily (on
 * first actual use, not at module load) so that importing this module never
 * crashes the build or a route that doesn't end up calling Claude — no live
 * key exists yet in this environment. `createMessage()` is the single
 * choke point every `lib/claude/prompts/*` module should call through, so
 * every Claude call (analyze now, match in M5) gets the same clear,
 * typed failure behavior instead of a raw/cryptic SDK error bubbling up.
 *
 * Nothing in this module logs request or response bodies — those can
 * contain resume/job-description PII (see module docstrings in
 * `lib/claude/prompts/*` and `lib/storage/resumeFiles.ts` for the same
 * rule elsewhere).
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * Thrown when `ANTHROPIC_API_KEY` is missing at the moment a Claude call is
 * actually attempted. Deliberately distinct from `ClaudeApiError` so tests
 * can assert on "misconfigured" vs. "the API call itself failed" — but
 * `createMessage()` wraps both into `ClaudeApiError` for route handlers, so
 * callers only need to catch one error type to produce a `502`.
 */
export class ClaudeConfigurationError extends Error {
  constructor(
    message = "ANTHROPIC_API_KEY is not configured. Set it in .env.local (see .env.local.example).",
  ) {
    super(message);
    this.name = "ClaudeConfigurationError";
  }
}

/**
 * Thrown for any failure calling the Claude API: missing configuration,
 * network failure, non-2xx response (including rate limits), or the SDK
 * throwing for any other reason. Route handlers catch this and return
 * `502 Bad Gateway`, per docs/ARCHITECTURE.md §2.
 */
export class ClaudeApiError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ClaudeApiError";
  }
}

/** Default Claude model for JobMatch's structured-extraction calls. */
export const CLAUDE_MODEL = "claude-sonnet-5";

let cachedClient: Anthropic | null = null;

/**
 * Returns a lazily-constructed, module-cached Anthropic client. Throws
 * `ClaudeConfigurationError` if `ANTHROPIC_API_KEY` isn't set — callers
 * should generally prefer `createMessage()` below rather than calling this
 * directly, so that failure is uniformly wrapped as `ClaudeApiError`.
 */
export function getClaudeClient(): Anthropic {
  if (cachedClient) {
    return cachedClient;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClaudeConfigurationError();
  }

  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

/**
 * Thin wrapper around `client.messages.create()` (non-streaming) that
 * centralizes error handling: a missing API key, a network failure, a
 * rate-limited/non-2xx response, or any other SDK-level throw are all
 * normalized into `ClaudeApiError` so route handlers have exactly one error
 * type to catch and map to `502`, per docs/ARCHITECTURE.md §2. Never
 * throws a raw SDK error and never crashes the process — the caller always
 * gets a typed, catchable error.
 */
export async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  let client: Anthropic;
  try {
    client = getClaudeClient();
  } catch (err) {
    throw new ClaudeApiError(
      err instanceof Error ? err.message : "Claude client is not configured.",
      err,
    );
  }

  try {
    return await client.messages.create(params);
  } catch (err) {
    throw new ClaudeApiError(
      `Claude API call failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
      err,
    );
  }
}

/** Test-only hook to reset the module-cached client between tests. */
export function __resetClaudeClientForTests(): void {
  cachedClient = null;
}
