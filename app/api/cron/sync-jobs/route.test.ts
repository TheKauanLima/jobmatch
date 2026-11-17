import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateAdminClient, mockEnqueueSourceSyncs, mockKickWorker, afterCallbacks } = vi.hoisted(() => ({
  mockCreateAdminClient: vi.fn(),
  mockEnqueueSourceSyncs: vi.fn(),
  mockKickWorker: vi.fn(),
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (cb: () => unknown) => {
      afterCallbacks.push(cb);
    },
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}));

vi.mock("@/lib/supabase/queries/sources", () => ({
  enqueueSourceSyncs: mockEnqueueSourceSyncs,
}));

vi.mock("@/lib/tasks/kick", () => ({
  kickWorker: mockKickWorker,
}));

const { GET } = await import("@/app/api/cron/sync-jobs/route");

const ORIGINAL_ENV = { ...process.env };

function makeRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/cron/sync-jobs", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  process.env.CRON_SECRET = "test-secret";
  mockCreateAdminClient.mockReturnValue({ admin: true });
  mockKickWorker.mockResolvedValue(true);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/cron/sync-jobs (enqueue only, §13.13.8)", () => {
  it("returns 500 (fails closed) when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest({ authorization: "Bearer anything" }));
    expect(res.status).toBe(500);
    expect(mockEnqueueSourceSyncs).not.toHaveBeenCalled();
  });

  it("returns 500 when CRON_SECRET is blank", async () => {
    process.env.CRON_SECRET = "   ";
    const res = await GET(makeRequest({ authorization: "Bearer    " }));
    expect(res.status).toBe(500);
    expect(mockEnqueueSourceSyncs).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockEnqueueSourceSyncs).not.toHaveBeenCalled();
  });

  it.each(["Bearer wrong-secret", "Bearer test-secretX", "test-secret", "Basic test-secret", "Bearer "])(
    "returns 401 for Authorization %j",
    async (authorization) => {
      const res = await GET(makeRequest({ authorization }));
      expect(res.status).toBe(401);
      expect(mockEnqueueSourceSyncs).not.toHaveBeenCalled();
      expect(afterCallbacks).toHaveLength(0);
    },
  );

  it("enqueues via enqueue_source_syncs with the admin client, returns 202 { enqueued }, and kicks the worker in after()", async () => {
    mockEnqueueSourceSyncs.mockResolvedValue(3);

    const res = await GET(makeRequest({ authorization: "Bearer test-secret" }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ enqueued: 3 });
    expect(mockEnqueueSourceSyncs).toHaveBeenCalledWith({ admin: true });
    expect(mockKickWorker).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(mockKickWorker).toHaveBeenCalledTimes(1);
  });

  it("never syncs inline (no adapter or sync module is imported by the route)", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/lib\/jobs\/sync|syncThemuseJobs|lib\/jobs\/sources/);
  });

  it("returns 500 without kicking when enqueue_source_syncs fails", async () => {
    mockEnqueueSourceSyncs.mockRejectedValue(new Error("db down"));
    const res = await GET(makeRequest({ authorization: "Bearer test-secret" }));
    expect(res.status).toBe(500);
    expect(afterCallbacks).toHaveLength(0);
  });
});
