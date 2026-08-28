/**
 * Per-user daily rate cap for Claude-backed endpoints, per
 * docs/ARCHITECTURE.md §5 (resolved decision): 20 calls/day/user for both
 * `/api/resumes/:id/analyze` (this milestone) and `/api/matches` (M5).
 * Deliberately generic over `kind` so the same module/logic is reused for
 * both rather than duplicated.
 *
 * Counts *today's* rows (UTC calendar day, per §5 — "end of day, UTC is
 * fine for v1") in the relevant history table for that user:
 *   - `kind: "analyze"` -> `resume_analyses`
 *   - `kind: "match"`   -> `matches` (wired up in M5)
 *
 * Both tables are insert-only history tables scoped by `user_id` with RLS
 * (docs/ARCHITECTURE.md §1), so counting "rows created today for this user"
 * is an accurate proxy for "Claude calls made today" — every successful
 * call inserts exactly one row, and failed calls (which don't insert a row)
 * don't count against the cap.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";

type Client = SupabaseClient<Database>;

export type RateLimitKind = "analyze" | "match";

/** Default daily caps per docs/ARCHITECTURE.md §5. Not env-configurable for v1. */
export const DAILY_RATE_LIMITS: Record<RateLimitKind, number> = {
  analyze: 20,
  match: 20,
};

const TABLE_BY_KIND: Record<RateLimitKind, "resume_analyses" | "matches"> = {
  analyze: "resume_analyses",
  match: "matches",
};

export type RateLimitConfig = {
  kind: RateLimitKind;
  /** Caller-supplied cap (see `DAILY_RATE_LIMITS` for the resolved defaults). */
  limit: number;
};

export type RateLimitResult =
  | { allowed: true; count: number; limit: number }
  | { allowed: false; count: number; limit: number; retryAfter: string };

/** Thrown when the Postgres count query itself fails (not a "limit exceeded" case). */
export class RateLimitQueryError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RateLimitQueryError";
  }
}

/** Start of the current UTC calendar day, as an ISO timestamp. */
function startOfTodayUtc(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/** Start of the next UTC calendar day (i.e. when the cap resets), as an ISO timestamp. */
function startOfNextDayUtc(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

/**
 * Checks whether `userId` is at or over their daily cap for `config.kind`.
 * Counts today's (UTC) rows they own in the relevant table via a `head`
 * count query (no row data fetched/logged — count only). Callers (route
 * handlers) run this *before* making the Claude call and return `429` with
 * `retryAfter` as the `retry_after` hint when `allowed` is `false`.
 */
export async function checkRateLimit(
  supabase: Client,
  userId: string,
  config: RateLimitConfig,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const table = TABLE_BY_KIND[config.kind];

  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", startOfTodayUtc(now));

  if (error) {
    throw new RateLimitQueryError(
      `Failed to check ${config.kind} rate limit: ${error.message}`,
      error,
    );
  }

  const used = count ?? 0;

  if (used >= config.limit) {
    return {
      allowed: false,
      count: used,
      limit: config.limit,
      retryAfter: startOfNextDayUtc(now),
    };
  }

  return { allowed: true, count: used, limit: config.limit };
}
