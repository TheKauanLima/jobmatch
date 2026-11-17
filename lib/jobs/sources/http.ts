/**
 * HTTP helper shared by job-source adapters (docs/ARCHITECTURE.md §13.6.6,
 * §13.6.7).
 *
 * - User-Agent `Kalify/2.0 (+${APP_BASE_URL}; ${INGEST_CONTACT_EMAIL})`,
 *   omitting whichever part isn't configured.
 * - A per-request timeout combined with the task's abort signal.
 * - Non-2xx responses and network failures become `SourceHttpError`, which
 *   carries the status and a parsed `Retry-After` so `lib/jobs/sync.ts` can
 *   honor a 429 once. Error messages carry the host and status only: never
 *   a response body (it could echo listing text) or query parameters.
 */

/** Per-request timeout; the task's own deadline still applies on top. */
export const SOURCE_REQUEST_TIMEOUT_MS = 30_000;

export class SourceHttpError extends Error {
  /** HTTP status, or null for a network error / timeout. */
  readonly status: number | null;
  /** Seconds from `Retry-After`, when the response had a usable one. */
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number | null, retryAfterSeconds: number | null, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SourceHttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type Env = Record<string, string | undefined>;

export function buildSourceUserAgent(env: Env = process.env): string {
  const parts = [env.APP_BASE_URL?.trim() ? `+${env.APP_BASE_URL.trim()}` : null, env.INGEST_CONTACT_EMAIL?.trim() || null].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? `Kalify/2.0 (${parts.join("; ")})` : "Kalify/2.0";
}

/**
 * Parses `Retry-After` (delta-seconds or an HTTP date). Returns null when
 * absent or unparseable; never negative.
 */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // Signed or fractional numbers aren't valid delta-seconds (and Date.parse
  // would read "-5" as a year).
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

export interface FetchSourceJsonOptions {
  signal: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: Env;
}

/** GETs `url` and returns the parsed JSON body. */
export async function fetchSourceJson(url: URL, options: FetchSourceJsonOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = url.host;
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? SOURCE_REQUEST_TIMEOUT_MS),
  ]);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": buildSourceUserAgent(options.env),
        ...options.headers,
      },
      signal,
      cache: "no-store",
    });
  } catch (err) {
    // The task deadline firing is not a source failure; let it propagate.
    if (options.signal.aborted) throw options.signal.reason ?? err;
    throw new SourceHttpError(`Request to ${host} failed (network error or timeout).`, null, null, err);
  }

  if (!response.ok) {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    // Drain the body so the connection can be reused; never read it into a message.
    await response.body?.cancel().catch(() => undefined);
    throw new SourceHttpError(`${host} returned HTTP ${response.status}.`, response.status, retryAfter);
  }

  try {
    return await response.json();
  } catch (err) {
    if (options.signal.aborted) throw options.signal.reason ?? err;
    throw new SourceHttpError(`${host} returned a body that is not valid JSON.`, response.status, null, err);
  }
}
