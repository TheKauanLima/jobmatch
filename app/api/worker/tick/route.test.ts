import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRunWorkerTick, mockAfter, afterCallbacks } = vi.hoisted(() => {
  const afterCallbacks: (() => unknown)[] = [];
  return {
    afterCallbacks,
    mockRunWorkerTick: vi.fn(),
    mockAfter: vi.fn((cb: () => unknown) => {
      afterCallbacks.push(cb);
    }),
  };
});

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mockAfter };
});
vi.mock("@/lib/tasks/worker", () => ({ runWorkerTick: mockRunWorkerTick }));
vi.mock("@/lib/tasks/registerUsageSink", () => ({ USAGE_SINK_REGISTERED: true }));

const route = await import("@/app/api/worker/tick/route");
const { POST, maxDuration } = route;

const ORIGINAL_ENV = { ...process.env };

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/worker/tick", {
    method: "POST",
    headers,
    body: '{"trigger":"cron"}',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  process.env.WORKER_SECRET = "s3cret";
  delete process.env.VERCEL_ENV;
  mockRunWorkerTick.mockResolvedValue({ claimed: 0 });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("POST /api/worker/tick", () => {
  it("declares maxDuration = 300 (Vercel Hobby with Fluid compute)", () => {
    expect(maxDuration).toBe(300);
  });

  it("returns 500 and does no work when WORKER_SECRET is unset", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.WORKER_SECRET;
    const res = await POST(req({ authorization: "Bearer anything" }));
    expect(res.status).toBe(500);
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockRunWorkerTick).not.toHaveBeenCalled();
  });

  it("returns 403 and schedules nothing on a non-production Vercel deployment", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.VERCEL_ENV = "preview";
    const res = await POST(req({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(403);
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockRunWorkerTick).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).toContain("non-production");
  });

  it("refuses previews even when the secret is unset (403 before 500)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.VERCEL_ENV = "preview";
    delete process.env.WORKER_SECRET;
    expect((await POST(req({ authorization: "Bearer x" }))).status).toBe(403);
  });

  it("runs on production (VERCEL_ENV=production)", async () => {
    process.env.VERCEL_ENV = "production";
    const res = await POST(req({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(202);
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it("returns 401 for a wrong or missing secret", async () => {
    expect((await POST(req({ authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await POST(req())).status).toBe(401);
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it("returns 202 immediately and runs the worker inside after()", async () => {
    const before = Date.now();
    const res = await POST(req({ authorization: "Bearer s3cret" }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    // Not run yet: only scheduled.
    expect(mockRunWorkerTick).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();
    expect(mockRunWorkerTick).toHaveBeenCalledTimes(1);
    const [{ invocationId, startedAt }] = mockRunWorkerTick.mock.calls[0];
    expect(invocationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(Date.now());
  });

  it("uses a fresh invocation id (fencing token) per request", async () => {
    await POST(req({ authorization: "Bearer s3cret" }));
    await POST(req({ authorization: "Bearer s3cret" }));
    await Promise.all(afterCallbacks.map((cb) => cb()));
    const ids = mockRunWorkerTick.mock.calls.map(([p]) => p.invocationId);
    expect(new Set(ids).size).toBe(2);
  });

  it("swallows (and logs) a worker failure inside after()", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRunWorkerTick.mockRejectedValue(new Error("createAdminClient: env missing"));
    await POST(req({ authorization: "Bearer s3cret" }));
    await expect(afterCallbacks[0]()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
