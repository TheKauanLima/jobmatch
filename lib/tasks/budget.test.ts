import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BUDGET_SNOOZE_MAX_JITTER_SECONDS,
  checkGlobalAiBudget,
  DEFAULT_GLOBAL_DAILY_AI_BUDGET_USD,
  getGlobalDailyAiBudgetUsd,
  nextUtcMidnight,
  secondsUntilBudgetReset,
  startOfUtcDay,
} from "@/lib/tasks/budget";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getGlobalDailyAiBudgetUsd", () => {
  it("defaults to 15 when unset or blank", () => {
    expect(getGlobalDailyAiBudgetUsd({})).toBe(DEFAULT_GLOBAL_DAILY_AI_BUDGET_USD);
    expect(getGlobalDailyAiBudgetUsd({ GLOBAL_DAILY_AI_BUDGET_USD: "  " })).toBe(15);
  });

  it("parses valid numbers, including 0", () => {
    expect(getGlobalDailyAiBudgetUsd({ GLOBAL_DAILY_AI_BUDGET_USD: "7.5" })).toBe(7.5);
    expect(getGlobalDailyAiBudgetUsd({ GLOBAL_DAILY_AI_BUDGET_USD: "0" })).toBe(0);
  });

  it("falls back to the default (with a warning) for invalid values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getGlobalDailyAiBudgetUsd({ GLOBAL_DAILY_AI_BUDGET_USD: "abc" })).toBe(15);
    expect(getGlobalDailyAiBudgetUsd({ GLOBAL_DAILY_AI_BUDGET_USD: "-1" })).toBe(15);
    expect(getGlobalDailyAiBudgetUsd({ GLOBAL_DAILY_AI_BUDGET_USD: "Infinity" })).toBe(15);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("UTC day helpers", () => {
  it("compute the UTC day boundaries regardless of local time zone", () => {
    const now = new Date("2026-11-04T23:59:30.000Z");
    expect(startOfUtcDay(now).toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(nextUtcMidnight(now).toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });

  it("secondsUntilBudgetReset adds 0–15 min of jitter after midnight", () => {
    const now = new Date("2026-11-04T23:59:30.000Z");
    expect(secondsUntilBudgetReset(now, () => 0)).toBe(30);
    expect(secondsUntilBudgetReset(now, () => 1)).toBe(30 + BUDGET_SNOOZE_MAX_JITTER_SECONDS);
    expect(secondsUntilBudgetReset(now, () => Number.NaN)).toBe(30 + BUDGET_SNOOZE_MAX_JITTER_SECONDS / 2);
  });
});

describe("checkGlobalAiBudget", () => {
  const now = new Date("2026-11-04T12:00:00.000Z");

  it("queries spend since the start of the UTC day", async () => {
    const getSpend = vi.fn().mockResolvedValue(3);
    const status = await checkGlobalAiBudget(getSpend, now, 15);
    expect(getSpend).toHaveBeenCalledWith(new Date("2026-11-04T00:00:00.000Z"));
    expect(status).toEqual({ spentUsd: 3, budgetUsd: 15, exhausted: false });
  });

  it("is exhausted at or above the budget", async () => {
    expect((await checkGlobalAiBudget(async () => 15, now, 15)).exhausted).toBe(true);
    expect((await checkGlobalAiBudget(async () => 20, now, 15)).exhausted).toBe(true);
    expect((await checkGlobalAiBudget(async () => 0, now, 0)).exhausted).toBe(true);
  });

  it("propagates spend-query errors to the caller", async () => {
    await expect(
      checkGlobalAiBudget(async () => {
        throw new Error("db down");
      }, now, 15),
    ).rejects.toThrow("db down");
  });
});
