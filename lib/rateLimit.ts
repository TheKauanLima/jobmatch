import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, RateLimitKind } from "@/types/database";

/**
 * Per-user daily rate limits backed by `rate_limit_events` and
 * `private.rate_limits` (docs/ARCHITECTURE.md §13.3.1, §13.9.3).
 *
 * This is the v2 module that replaces `lib/claude/rateLimit.ts` (§13.9.3).
 * The v1 `analyze` / `match` caps stay in that file until their routes are
 * retired (M3.9); the shared UTC-day helper lives here.
 *
 * Enforcement happens in SQL: limits live in `private.rate_limits` and are
 * charged by security-definer RPCs, so nothing here takes a limit or a user
 * id as an argument that a caller could forge. Every function takes the
 * caller's **cookie-bound session client** (`lib/supabase/server.ts`), never
 * the admin client: the RPCs resolve the user from `auth.uid()`.
 *
 * Error messages carry the RPC name plus PostgREST's code/message only.
 */

type SessionClient = SupabaseClient<Database>;

/** SQLSTATE the user RPCs raise when `auth.uid()` is null. */
const POSTGRES_INSUFFICIENT_PRIVILEGE = "42501";

/** Thrown when a rate-limit RPC itself fails (not a "limit reached" outcome). */
export class RateLimitRpcError extends Error {
  readonly code: string | null;

  constructor(
    operation: string,
    error: { code?: string | null; message?: string | null },
  ) {
    const code = error.code ?? null;
    const detail = (error.message ?? "unknown error").slice(0, 300);
    super(`${operation} failed${code ? ` (${code})` : ""}: ${detail}`);
    this.name = "RateLimitRpcError";
    this.code = code;
  }

  /** The RPC raised `unauthenticated` (no `auth.uid()` on the request). */
  get isUnauthenticated(): boolean {
    return this.code === POSTGRES_INSUFFICIENT_PRIVILEGE;
  }
}

/**
 * Start of the next UTC calendar day as an ISO timestamp: when every daily
 * limit resets, and the `retry_after` value in every `429 rate_limited`
 * response (§13.9.3, same convention as §5).
 */
export function nextUtcMidnight(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

export type AccountReauthAttemptResult =
  | { allowed: true }
  | { allowed: false; retryAfter: string };

/**
 * Charges one `account_reauth` attempt to the signed-in caller via
 * `consume_account_reauth_attempt()` (§13.3.1, §13.13.7 step 0). Every
 * attempt counts, successful or not.
 *
 * Must run before anything contacts GoTrue. Fails closed: an RPC error, or
 * any response other than a boolean, throws `RateLimitRpcError`, and the
 * caller returns `500` without attempting the password check.
 */
export async function consumeAccountReauthAttempt(
  supabase: SessionClient,
  now: Date = new Date(),
): Promise<AccountReauthAttemptResult> {
  const { data, error } = await supabase.rpc("consume_account_reauth_attempt");

  if (error) {
    throw new RateLimitRpcError("consume_account_reauth_attempt", error);
  }
  if (data === true) {
    return { allowed: true };
  }
  if (data === false) {
    return { allowed: false, retryAfter: nextUtcMidnight(now) };
  }
  throw new RateLimitRpcError("consume_account_reauth_attempt", {
    message: "unexpected non-boolean result",
  });
}

export interface RateLimitStatus {
  kind: RateLimitKind;
  daily_limit: number;
  used_today: number;
  /** ISO timestamp of the next UTC midnight. */
  resets_at: string;
}

/**
 * The caller's daily limits and today's non-refunded usage for every kind
 * (including `account_reauth`), from `get_my_rate_limits()` (§13.3.1).
 * Throws `RateLimitRpcError` on failure; `isUnauthenticated` is true when
 * the request carried no valid session.
 */
export async function getMyRateLimits(
  supabase: SessionClient,
): Promise<RateLimitStatus[]> {
  const { data, error } = await supabase.rpc("get_my_rate_limits");

  if (error) {
    throw new RateLimitRpcError("get_my_rate_limits", error);
  }

  return (data ?? []).map((row) => ({
    kind: row.kind,
    daily_limit: row.daily_limit,
    used_today: row.used_today,
    resets_at: toIsoTimestamp(row.resets_at),
  }));
}

/**
 * PostgREST renders timestamptz as e.g. `2026-11-10T00:00:00+00:00`;
 * normalize to the `Z` form `retry_after` uses. Unparseable input is
 * passed through unchanged rather than dropped.
 */
function toIsoTimestamp(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}
