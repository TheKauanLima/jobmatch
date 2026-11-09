import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateAdminClient, mockGetTaskCounts, mockListRecentDeadTasks, mockGetAiSpendSince, mockCountPendingDeadHooks } = vi.hoisted(() => ({
  mockCountPendingDeadHooks: vi.fn(),
  mockCreateAdminClient: vi.fn(() => ({ tag: "admin" })),
  mockGetTaskCounts: vi.fn(),
  mockListRecentDeadTasks: vi.fn(),
  mockGetAiSpendSince: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockCreateAdminClient }));
vi.mock("@/lib/supabase/queries/tasks", () => ({
  getTaskCounts: mockGetTaskCounts,
  listRecentDeadTasks: mockListRecentDeadTasks,
  countPendingDeadHooks: mockCountPendingDeadHooks,
}));
vi.mock("@/lib/supabase/queries/usage", () => ({ getAiSpendSince: mockGetAiSpendSince }));

const { GET } = await import("@/app/api/worker/status/route");

const ORIGINAL_ENV = { ...process.env };

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/worker/status", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WORKER_SECRET = "s3cret";
  mockGetTaskCounts.mockResolvedValue({ "maintenance.noop": { succeeded: 3, dead: 1 } });
  mockCountPendingDeadHooks.mockResolvedValue(2);
  mockListRecentDeadTasks.mockResolvedValue([
    { id: "t1", kind: "maintenance.noop", code: "internal_error", attempts: 3, finished_at: "2026-11-04T12:00:00Z" },
  ]);
  mockGetAiSpendSince.mockResolvedValue([
    { provider: "anthropic", operation: "critiqueResume", costUsd: 0.2, calls: 1 },
    { provider: "anthropic", operation: "analyzeResume", costUsd: 0.1, calls: 2 },
    { provider: "voyage", operation: "embed", costUsd: 0.00002, calls: 1 },
  ]);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("GET /api/worker/status", () => {
  it("returns 500 when WORKER_SECRET is unset, 401 when wrong", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.WORKER_SECRET;
    expect((await GET(req({ authorization: "Bearer s3cret" }))).status).toBe(500);
    process.env.WORKER_SECRET = "s3cret";
    expect((await GET(req({ authorization: "Bearer nope" }))).status).toBe(401);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("returns counts, recent dead tasks and today's spend", async () => {
    const res = await GET(req({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.json();
    expect(body.counts).toEqual({ "maintenance.noop": { succeeded: 3, dead: 1 } });
    expect(body.recent_dead).toHaveLength(1);
    expect(body.recent_dead[0]).not.toHaveProperty("payload");
    expect(body.dead_hooks_pending).toBe(2);
    expect(body.spend_today).toEqual({ anthropic: 0.3, voyage: 0.00002 });
    expect(body.spend_today_by_operation).toHaveLength(3);
    expect(mockListRecentDeadTasks).toHaveBeenCalledWith(expect.anything(), 20);

    // Spend is measured from the start of the current UTC day.
    const since: Date = mockGetAiSpendSince.mock.calls[0][1];
    expect(since.getUTCHours()).toBe(0);
    expect(since.getUTCMinutes()).toBe(0);
    expect(Date.now() - since.getTime()).toBeLessThan(24 * 3600 * 1000);
  });

  it("returns 500 when a query fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetTaskCounts.mockRejectedValue(new Error("db down"));
    const res = await GET(req({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(500);
  });
});
