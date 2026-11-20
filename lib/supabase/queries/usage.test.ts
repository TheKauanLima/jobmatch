import { describe, expect, it, vi } from "vitest";

import { getAiSpendSince, insertAiUsageEvent, UsageQueryError } from "@/lib/supabase/queries/usage";

describe("usage queries", () => {
  it("insertAiUsageEvent inserts into ai_usage_events", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ insert }));
    const row = { provider: "anthropic" as const, operation: "x", model: "m", cost_usd: 0.1 };
    await insertAiUsageEvent({ from } as never, row);
    expect(from).toHaveBeenCalledWith("ai_usage_events");
    expect(insert).toHaveBeenCalledWith(row);
  });

  it("insertAiUsageEvent throws UsageQueryError on failure", async () => {
    const from = vi.fn(() => ({ insert: vi.fn().mockResolvedValue({ error: { code: "23514", message: "violates check" } }) }));
    await expect(
      insertAiUsageEvent({ from } as never, { provider: "anthropic", operation: "x", model: "m", cost_usd: 0 }),
    ).rejects.toBeInstanceOf(UsageQueryError);
  });

  it("getAiSpendSince calls ai_spend_summary and coerces numerics", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { provider: "anthropic", operation: "critique", cost_usd: "0.250000", calls: "2" },
        { provider: "voyage", operation: "embed", cost_usd: 0.001, calls: 1 },
      ],
      error: null,
    });
    const since = new Date("2026-11-04T00:00:00.000Z");
    const rows = await getAiSpendSince({ rpc } as never, since);
    expect(rpc).toHaveBeenCalledWith("ai_spend_summary", { p_since: "2026-11-04T00:00:00.000Z" });
    expect(rows).toEqual([
      { provider: "anthropic", operation: "critique", costUsd: 0.25, calls: 2 },
      { provider: "voyage", operation: "embed", costUsd: 0.001, calls: 1 },
    ]);
  });

  it("getAiSpendSince propagates errors (callers fail closed)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });
    await expect(getAiSpendSince({ rpc } as never, new Date())).rejects.toThrow(/ai_spend_summary failed/);
  });
});
