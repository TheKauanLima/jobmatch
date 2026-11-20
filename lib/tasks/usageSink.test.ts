import { afterEach, describe, expect, it, vi } from "vitest";

const { mockInsert } = vi.hoisted(() => ({ mockInsert: vi.fn() }));

vi.mock("@/lib/supabase/queries/usage", () => ({
  insertAiUsageEvent: mockInsert,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("must not create a real client in tests");
  }),
}));

const { createDatabaseUsageSink, toUsageRow, USAGE_SINK_ALERT_PREFIX } = await import("@/lib/tasks/usageSink");
type AiUsageEvent = Parameters<typeof toUsageRow>[0];

const USER = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";

const event: AiUsageEvent = {
  provider: "anthropic",
  operation: "critiqueResume",
  model: "claude-opus-5-5",
  isBatch: false,
  inputTokens: 8000,
  outputTokens: 9000,
  cacheReadTokens: 100,
  cacheWriteTokens: 50,
  costUsd: 0.2120004,
  stopReason: "end_turn",
  requestId: "req_123",
  userId: USER,
  taskId: TASK,
  taskAttempt: 1,
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("toUsageRow", () => {
  it("maps every field onto the ai_usage_events columns", () => {
    const out = toUsageRow(event);
    expect(out.row).toEqual({
      provider: "anthropic",
      operation: "critiqueResume",
      model: "claude-opus-5-5",
      is_batch: false,
      input_tokens: 8000,
      output_tokens: 9000,
      cache_read_tokens: 100,
      cache_write_tokens: 50,
      cost_usd: 0.212,
      stop_reason: "end_turn",
      request_id: "req_123",
      user_id: USER,
      task_id: TASK,
      task_attempt: 1,
    });
    expect("warnings" in out && out.warnings).toEqual([]);
  });

  it("normalizes bad numbers and ids without dropping the row", () => {
    const out = toUsageRow({
      ...event,
      inputTokens: -5,
      outputTokens: Number.NaN,
      costUsd: Number.NaN,
      userId: "not-a-uuid",
      taskId: null,
      taskAttempt: 1.5,
      stopReason: "   ",
    });
    expect(out.row).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      user_id: null,
      task_id: null,
      task_attempt: null,
      stop_reason: null,
    });
    expect("warnings" in out && out.warnings).toEqual([
      "invalid cost stored as 0",
      "malformed user_id stored as null",
    ]);
  });

  it("truncates strings to the column limits", () => {
    const out = toUsageRow({ ...event, operation: "o".repeat(500), model: "m".repeat(500) });
    expect(out.row?.operation).toHaveLength(100);
    expect(out.row?.model).toHaveLength(200);
  });

  it("refuses rows that would violate a check constraint", () => {
    expect(toUsageRow({ ...event, provider: "openai" as never })).toEqual({ row: null, reason: "invalid provider" });
    expect(toUsageRow({ ...event, model: "" }).row).toBeNull();
  });

  it("accepts voyage events with minimal fields", () => {
    const out = toUsageRow({ provider: "voyage", operation: "embed", model: "voyage-4-lite", costUsd: 0.00002 });
    expect(out.row).toMatchObject({ provider: "voyage", is_batch: false, input_tokens: 0, user_id: null });
  });
});

describe("createDatabaseUsageSink", () => {
  it("inserts through the service-role client, created once", async () => {
    const admin = { tag: "admin" };
    const getAdmin = vi.fn(() => admin as never);
    const sink = createDatabaseUsageSink({ getAdmin });

    await sink(event);
    await sink(event);

    expect(getAdmin).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(mockInsert.mock.calls[0][0]).toBe(admin);
    expect(mockInsert.mock.calls[0][1]).toMatchObject({ provider: "anthropic", cost_usd: 0.212 });
  });

  it("never throws when the insert fails, and logs without content", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInsert.mockRejectedValue(Object.assign(new Error("boom"), { name: "UsageQueryError", code: "23514" }));
    const sink = createDatabaseUsageSink({ getAdmin: () => ({}) as never });

    await expect(sink(event)).resolves.toBeUndefined();
    const logged = error.mock.calls.flat().join(" ");
    expect(String(error.mock.calls[0][0]).startsWith("[ALERT][usageSink] failed to record")).toBe(true);
    expect(USAGE_SINK_ALERT_PREFIX).toBe("[ALERT][usageSink] failed to record");
    expect(logged).toContain("UsageQueryError");
    expect(logged).toContain("23514");
    expect(logged).toContain("req_123");
  });

  it("never throws when the admin client can't be created", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = createDatabaseUsageSink({
      getAdmin: () => {
        throw new Error("env missing");
      },
    });
    await expect(sink(event)).resolves.toBeUndefined();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("skips unstorable events with an alertable log line", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = createDatabaseUsageSink({ getAdmin: () => ({}) as never });
    await sink({ ...event, provider: "openai" as never });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0][0])).toContain(USAGE_SINK_ALERT_PREFIX);
  });

  it("an invalid cost is stored as 0 but alerted (that spend is invisible to the budget)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = createDatabaseUsageSink({ getAdmin: () => ({}) as never });
    await sink({ ...event, costUsd: Number.NaN });
    expect(mockInsert.mock.calls[0][1]).toMatchObject({ cost_usd: 0 });
    expect(String(error.mock.calls[0][0])).toContain(USAGE_SINK_ALERT_PREFIX);
  });

  it("alert lines carry no PII-bearing fields", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInsert.mockRejectedValue(new Error("Jane Doe row data"));
    const sink = createDatabaseUsageSink({ getAdmin: () => ({}) as never });
    await sink(event);
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).not.toContain("Jane");
    expect(logged).not.toContain(USER);
  });

  it("is assignable to the Claude layer's UsageSink (M1.1 registration)", async () => {
    // Type-level check: compiles only if the event shapes line up.
    const { setUsageSink } = await import("@/lib/claude/usage");
    const sink = createDatabaseUsageSink({ getAdmin: () => ({}) as never });
    setUsageSink(sink);
    setUsageSink(null);
  });
});
