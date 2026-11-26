import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SyncCompanyResult,
  SyncExternalJobsResult,
} from "@/lib/jobs/sync";

const { mockCreateAdminClient, mockSyncExternalJobs, mockBackfillJobFacets } = vi.hoisted(() => ({
  mockCreateAdminClient: vi.fn(),
  mockSyncExternalJobs: vi.fn(),
  mockBackfillJobFacets: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}));

vi.mock("@/lib/jobs/sync", () => ({
  syncExternalJobs: mockSyncExternalJobs,
}));

vi.mock("@/lib/jobs/backfillFacets", async () => ({
  ...(await vi.importActual<typeof import("@/lib/jobs/backfillFacets")>(
    "@/lib/jobs/backfillFacets",
  )),
  backfillJobFacets: mockBackfillJobFacets,
}));

const FACET_BACKFILL_OK = { updated: 3, remaining: false };

const route = await import("@/app/api/cron/sync-jobs/route");
const { GET } = route;

const ORIGINAL_ENV = { ...process.env };
const adminClient = { admin: true };

function makeRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/cron/sync-jobs", { headers });
}

function company(
  token: string,
  status: SyncCompanyResult["status"],
  error: string | null = null,
): SyncCompanyResult {
  return {
    provider: "greenhouse",
    token,
    status,
    fetched: status === "ok" ? 10 : 0,
    kept: status === "ok" ? 2 : 0,
    upserted: status === "ok" ? 2 : 0,
    softDeleted: 0,
    error,
  };
}

function syncResult(companies: SyncCompanyResult[]): SyncExternalJobsResult {
  return {
    companies,
    totalUpserted: companies.reduce((s, c) => s + c.upserted, 0),
    totalSoftDeleted: 0,
    durationMs: 1234,
  };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-secret";
  mockCreateAdminClient.mockReturnValue(adminClient);
  mockBackfillJobFacets.mockResolvedValue(FACET_BACKFILL_OK);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  consoleError.mockRestore();
});

describe("GET /api/cron/sync-jobs", () => {
  it("allows up to 60 s on Vercel (maxDuration)", () => {
    expect(route.maxDuration).toBe(60);
  });

  it("returns 500 (fails closed) when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;

    const res = await GET(makeRequest({ authorization: "Bearer anything" }));

    expect(res.status).toBe(500);
    expect(mockSyncExternalJobs).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("returns 500 when CRON_SECRET is an empty string (unset must never mean open)", async () => {
    process.env.CRON_SECRET = "";

    const res = await GET(makeRequest({ authorization: "Bearer " }));

    expect(res.status).toBe(500);
    expect(mockSyncExternalJobs).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockSyncExternalJobs).not.toHaveBeenCalled();
  });

  it("returns 401 when the bearer token doesn't match CRON_SECRET", async () => {
    const res = await GET(makeRequest({ authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(401);
    expect(mockSyncExternalJobs).not.toHaveBeenCalled();
  });

  it("runs the sync with the admin client and returns 200 with the result when every company is ok", async () => {
    const result = syncResult([company("a", "ok"), company("b", "ok")]);
    mockSyncExternalJobs.mockResolvedValue(result);

    const res = await GET(makeRequest({ authorization: "Bearer test-secret" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...result, facetBackfill: FACET_BACKFILL_OK });
    expect(mockSyncExternalJobs).toHaveBeenCalledTimes(1);
    expect(mockSyncExternalJobs).toHaveBeenCalledWith(adminClient);
    expect(mockBackfillJobFacets).toHaveBeenCalledWith(adminClient, {
      deadlineMs: expect.any(Number),
    });
  });

  it("returns 207 with facetBackfill when the facet backfill fails (§7.8.4)", async () => {
    const { FacetBackfillError } = await import("@/lib/jobs/backfillFacets");
    const result = syncResult([company("a", "ok")]);
    mockSyncExternalJobs.mockResolvedValue(result);
    mockBackfillJobFacets.mockRejectedValue(new FacetBackfillError("1 failed", 7));

    const res = await GET(makeRequest({ authorization: "Bearer test-secret" }));

    expect(res.status).toBe(207);
    expect(await res.json()).toEqual({
      ...result,
      facetBackfill: { updated: 7, remaining: true },
    });
  });

  it.each([
    ["not_found", 'greenhouse board "b" returned HTTP 404'],
    ["error", 'greenhouse board "b" returned HTTP 503'],
    ["skipped_time_budget", null],
  ] as const)(
    "returns 207 with the full per-company result when a company is %s",
    async (status, error) => {
      const result = syncResult([company("a", "ok"), company("b", status, error)]);
      mockSyncExternalJobs.mockResolvedValue(result);

      const res = await GET(makeRequest({ authorization: "Bearer test-secret" }));

      expect(res.status).toBe(207);
      expect(await res.json()).toEqual({ ...result, facetBackfill: FACET_BACKFILL_OK });
    },
  );

  it("logs only provider:token=status for a partial failure", async () => {
    mockSyncExternalJobs.mockResolvedValue(
      syncResult([company("a", "ok"), company("b", "error", 'greenhouse board "b" timed out')]),
    );

    await GET(makeRequest({ authorization: "Bearer test-secret" }));

    expect(consoleError).toHaveBeenCalledWith(
      "GET /api/cron/sync-jobs: partial failure:",
      "greenhouse:b=error",
    );
  });

  it("returns 502 with a generic body when syncExternalJobs throws", async () => {
    mockSyncExternalJobs.mockRejectedValue(new Error("unexpected"));

    const res = await GET(makeRequest({ authorization: "Bearer test-secret" }));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Failed to sync job listings." });
  });

  it("returns 502 when the admin client can't be created", async () => {
    mockCreateAdminClient.mockImplementation(() => {
      throw new Error("missing service role key");
    });

    const res = await GET(makeRequest({ authorization: "Bearer test-secret" }));

    expect(res.status).toBe(502);
    expect(mockSyncExternalJobs).not.toHaveBeenCalled();
  });
});
