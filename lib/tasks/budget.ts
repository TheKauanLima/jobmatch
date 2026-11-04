/**
 * Global daily AI spend guard (docs/ARCHITECTURE.md §13.9.4).
 *
 * `GLOBAL_DAILY_AI_BUDGET_USD` (default 15) is compared against today's
 * (UTC) `sum(ai_usage_events.cost_usd)` before the worker claims any
 * AI-calling kind. Over budget → AI tasks are snoozed to the next UTC
 * midnight plus jitter instead of running.
 *
 * The cap is soft by design: tasks already running when the threshold is
 * crossed finish, so spend can overshoot by at most the in-flight calls.
 *
 * `INGEST_DAILY_BUDGET_USD` / `INGEST_DAILY_EXTRACTION_CAP` bound
 * background requirement extraction and belong with that pipeline (M2.2).
 */

export const DEFAULT_GLOBAL_DAILY_AI_BUDGET_USD = 15;
/** Upper bound of the random delay added after UTC midnight. */
export const BUDGET_SNOOZE_MAX_JITTER_SECONDS = 15 * 60;

/**
 * Parses `GLOBAL_DAILY_AI_BUDGET_USD`. Unset/blank → default. Invalid
 * (non-numeric, negative, non-finite) → default, with a warning, so a typo
 * can't silently disable the guard. `0` is honored (pauses all AI work).
 */
export function getGlobalDailyAiBudgetUsd(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.GLOBAL_DAILY_AI_BUDGET_USD;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_GLOBAL_DAILY_AI_BUDGET_USD;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.warn(
      `[budget] GLOBAL_DAILY_AI_BUDGET_USD is invalid; using the default of ${DEFAULT_GLOBAL_DAILY_AI_BUDGET_USD}.`,
    );
    return DEFAULT_GLOBAL_DAILY_AI_BUDGET_USD;
  }
  return value;
}

export function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export function nextUtcMidnight(now: Date): Date {
  return new Date(startOfUtcDay(now).getTime() + 24 * 60 * 60 * 1000);
}

/** Seconds from `now` until the next UTC midnight plus 0–15 min of jitter. */
export function secondsUntilBudgetReset(
  now: Date,
  random: () => number = Math.random,
): number {
  const untilMidnight = Math.ceil(
    (nextUtcMidnight(now).getTime() - now.getTime()) / 1000,
  );
  const sample = random();
  const r = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.max(1, untilMidnight + Math.floor(r * BUDGET_SNOOZE_MAX_JITTER_SECONDS));
}

export interface BudgetStatus {
  spentUsd: number;
  budgetUsd: number;
  exhausted: boolean;
}

/**
 * @param getSpendSince returns total USD spent since the given instant,
 *   summed in SQL (`ai_spend_summary`). Errors propagate: the caller
 *   decides how to fail closed.
 */
export async function checkGlobalAiBudget(
  getSpendSince: (since: Date) => Promise<number>,
  now: Date,
  budgetUsd: number = getGlobalDailyAiBudgetUsd(),
): Promise<BudgetStatus> {
  const spentUsd = await getSpendSince(startOfUtcDay(now));
  return { spentUsd, budgetUsd, exhausted: spentUsd >= budgetUsd };
}
