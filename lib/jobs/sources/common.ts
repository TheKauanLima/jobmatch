/**
 * Shared plumbing for the Greenhouse and Lever board clients
 * (docs/ARCHITECTURE.md §7.7.4–7.7.5): the fetch wrapper with the Kalify
 * User-Agent, the provider error type, and small mapping helpers (externalId
 * format, clamping, URL/date checks) so both mappers apply them identically.
 */

import {
  JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH,
} from "@/lib/validation/schemas";
import type { JobBoardProvider } from "@/lib/jobs/sources/companies";

/**
 * Thrown when a board fetch fails. `status` is the HTTP status for a non-2xx
 * response, or `null` for a network error, timeout, or unexpected body.
 *
 * The message deliberately contains only the provider, token, and status (or
 * a fixed failure kind): never the response body, the request URL, or the
 * underlying error's text, because it ends up in the cron route's JSON
 * response and logs (§7.7.6: "short, no response body, no stack").
 */
export class JobBoardFetchError extends Error {
  constructor(
    readonly provider: JobBoardProvider,
    readonly token: string,
    readonly status: number | null,
    kind: "http" | "network" | "timeout" | "invalid_body",
  ) {
    const detail =
      kind === "http"
        ? `returned HTTP ${status}`
        : kind === "network"
          ? "network error"
          : kind === "timeout"
            ? "timed out"
            : "returned an unexpected response body";
    super(`${provider} board "${token}" ${detail}`);
    this.name = "JobBoardFetchError";
  }
}

/**
 * `Kalify/1.0 (+<APP_BASE_URL>)`, or plain `Kalify/1.0` when `APP_BASE_URL`
 * is unset (§7.7.5). No contact email (a v2 item needing the user's input).
 */
export function jobBoardUserAgent(
  env: Record<string, string | undefined> = process.env,
): string {
  const base = env.APP_BASE_URL?.trim();
  return base ? `Kalify/1.0 (+${base})` : "Kalify/1.0";
}

/**
 * GETs a board URL and parses its JSON body. One attempt, no retries
 * (§7.7.5). Any failure becomes a `JobBoardFetchError` carrying only
 * provider/token/status; the response body of a non-2xx is drained and
 * discarded, never read into an error.
 */
export async function fetchBoardJson(
  provider: JobBoardProvider,
  token: string,
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": jobBoardUserAgent(),
      },
      signal,
      cache: "no-store",
    });
  } catch (err) {
    throw new JobBoardFetchError(
      provider,
      token,
      null,
      isAbortError(err) ? "timeout" : "network",
    );
  }

  if (!response.ok) {
    // Release the connection without looking at the body.
    await response.body?.cancel().catch(() => undefined);
    throw new JobBoardFetchError(provider, token, response.status, "http");
  }

  try {
    return await response.json();
  } catch (err) {
    throw new JobBoardFetchError(
      provider,
      token,
      null,
      isAbortError(err) ? "timeout" : "invalid_body",
    );
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

/**
 * `${token}:${id}` (§13.6.2). The prefix also lets the soft-delete step find
 * one company's rows. Returns `null` for a missing/blank id.
 */
export function boardExternalId(token: string, id: unknown): string | null {
  if (typeof id === "number" && Number.isFinite(id)) return `${token}:${id}`;
  if (typeof id === "string" && id.trim() !== "") return `${token}:${id.trim()}`;
  return null;
}

/** Trims and clamps to `max` characters; blank becomes `null`. */
export function clampText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Returns the URL when it is an absolute http(s) URL that fits
 * `JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH`, else `null`. A too-long URL is
 * rejected rather than truncated, since a truncated URL is a broken link.
 */
export function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:"
      ? trimmed
      : null;
  } catch {
    return null;
  }
}

/** Normalizes an ISO date string or epoch-ms number to ISO-8601, else `null`. */
export function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
