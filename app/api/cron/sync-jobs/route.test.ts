import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateAdminClient, mockSyncThemuseJobs } = vi.hoisted(() => ({
  mockCreateAdminClient: vi.fn(),
  mockSyncThemuseJobs: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}));

vi.mock("@/lib/jobs/sync", () => ({
  syncThemuseJobs: mockSyncThemuseJobs,
}));

const { GET } = await import("@/app/api/cron/sync-jobs/route");

const ORIGINAL_ENV = { ...process.env };

function makeRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/cron/sync-jobs", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-secret";
  mockCreateAdminClient.mockReturnValue({});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/cron/sync-jobs", () => {
  it("returns 500 (fails closed) when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;

    const res = await GET(
      makeRequest({ authorization: "Bearer anything" }),
    );

    expect(res.status).toBe(500);
    expect(mockSyncThemuseJobs).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockSyncThemuseJobs).not.toHaveBeenCalled();
  });

  it("returns 401 when the bearer token doesn't match CRON_SECRET", async () => {
    const res = await GET(
      makeRequest({ authorization: "Bearer wrong-secret" }),
    );
    expect(res.status).toBe(401);
    expect(mockSyncThemuseJobs).not.toHaveBeenCalled();
  });

  it("runs the sync and returns 200 on full success", async () => {
    mockSyncThemuseJobs.mockResolvedValue({
      levels: [
        {
          level: "Internship",
          fetched: 10,
          mapped: 10,
          skippedInvalid: 0,
          pagesFetched: 1,
          error: null,
        },
      ],
      totalUpserted: 10,
    });

    const res = await GET(
      makeRequest({ authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.totalUpserted).toBe(10);
    expect(mockSyncThemuseJobs).toHaveBeenCalledTimes(1);
  });

  it("returns 207 when the sync reports a partial per-level failure", async () => {
    mockSyncThemuseJobs.mockResolvedValue({
      levels: [
        {
          level: "Internship",
          fetched: 0,
          mapped: 0,
          skippedInvalid: 0,
          pagesFetched: 0,
          error: "The Muse API returned 503",
        },
      ],
      totalUpserted: 0,
    });

    const res = await GET(
      makeRequest({ authorization: "Bearer test-secret" }),
    );
    expect(res.status).toBe(207);
  });

  it("returns 502 when syncThemuseJobs throws", async () => {
    mockSyncThemuseJobs.mockRejectedValue(new Error("unexpected"));

    const res = await GET(
      makeRequest({ authorization: "Bearer test-secret" }),
    );
    expect(res.status).toBe(502);
  });
});
