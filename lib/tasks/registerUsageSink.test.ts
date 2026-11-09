import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInsert, mockCreateAdminClient } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockCreateAdminClient: vi.fn(() => ({ tag: "admin" })),
}));

vi.mock("@/lib/supabase/queries/usage", () => ({ insertAiUsageEvent: mockInsert }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockCreateAdminClient }));

// The real Claude-layer recordUsage + the real registration side effect.
const { recordUsage, setUsageSink } = await import("@/lib/claude/usage");
const { USAGE_SINK_REGISTERED } = await import("@/lib/tasks/registerUsageSink");
const { USAGE_SINK_TIMEOUT_MS } = await import("@/lib/tasks/usageSink");

type UsageEvent = Parameters<typeof recordUsage>[0];

const event: UsageEvent = {
  provider: "anthropic",
  operation: "analyzeResume",
  model: "claude-opus-5-5",
  isBatch: false,
  inputTokens: 3000,
  outputTokens: 1200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.036,
  stopReason: "end_turn",
  requestId: "req_abc",
  userId: "11111111-1111-4111-8111-111111111111",
  taskId: null,
  taskAttempt: null,
};

beforeEach(() => {
  mockInsert.mockReset();
  mockInsert.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  setUsageSink(null);
});

describe("registerUsageSink", () => {
  it("registers the database sink on import: recordUsage writes ai_usage_events", async () => {
    expect(USAGE_SINK_REGISTERED).toBe(true);

    await recordUsage(event);

    expect(mockCreateAdminClient).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][1]).toEqual({
      provider: "anthropic",
      operation: "analyzeResume",
      model: "claude-opus-5-5",
      is_batch: false,
      input_tokens: 3000,
      output_tokens: 1200,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.036,
      stop_reason: "end_turn",
      request_id: "req_abc",
      user_id: "11111111-1111-4111-8111-111111111111",
      task_id: null,
      task_attempt: null,
    });
  });

  it("registration is process-wide (globalThis symbol), so other bundles see it", () => {
    const holder = globalThis as Record<symbol, unknown>;
    expect(typeof holder[Symbol.for("kalify.claude.usageSink")]).toBe("function");
  });

  it("a failing insert never fails the caller", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockInsert.mockRejectedValue(new Error("db down"));
    await expect(recordUsage(event)).resolves.toBeUndefined();
  });

  it("a hung insert stops blocking the caller after the timeout", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectInsert!: (err: Error) => void;
    mockInsert.mockReturnValue(
      new Promise((_, reject) => {
        rejectInsert = reject;
      }),
    );

    let settled = false;
    const pending = recordUsage(event).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(USAGE_SINK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("UsageSinkTimeoutError");

    // A late failure after the timeout is handled (no unhandled rejection) and logged.
    rejectInsert(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("failed after timing out");
  });

  it.each([
    "app/api/worker/tick/route.ts",
    "app/api/resumes/[id]/analyze/route.ts",
    "app/api/matches/route.ts",
  ])("%s imports the registration module", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source).toContain('import "@/lib/tasks/registerUsageSink";');
  });
});
