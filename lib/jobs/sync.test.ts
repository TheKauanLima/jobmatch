import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalJobDescriptionUpsert } from "@/lib/supabase/queries/jobDescriptions";

/**
 * In-memory stand-in for the job_descriptions upsert / snapshot close /
 * resolve_job_duplicates, so the sync's idempotency can be checked on the
 * resulting "table" rather than on call counts alone.
 */
const store = vi.hoisted(() => {
  type Row = Record<string, unknown> & { externalId: string };
  const rows = new Map<string, Row>();
  return {
    rows,
    upsertCalls: [] as Array<{ source: string; rows: unknown[] }>,
    resolveCalls: [] as string[][],
    closeCalls: [] as unknown[],
    closeResult: { closed: 0, dedupeKeys: [] as string[] },
    reset() {
      rows.clear();
      this.upsertCalls.length = 0;
      this.resolveCalls.length = 0;
      this.closeCalls.length = 0;
      this.closeResult = { closed: 0, dedupeKeys: [] };
    },
  };
});

vi.mock("@/lib/supabase/queries/jobDescriptions", () => ({
  upsertExternalJobDescriptions: vi.fn(async (_admin: unknown, source: string, rows: ExternalJobDescriptionUpsert[]) => {
    store.upsertCalls.push({ source, rows });
    const result = { count: 0, inserted: 0, updated: 0, unchanged: 0, reopened: 0, previousDedupeKeys: [] as string[] };
    for (const row of rows) {
      const prior = store.rows.get(row.externalId);
      if (!prior) result.inserted++;
      else if (prior.title === row.title && prior.company === row.company && prior.description === row.description) result.unchanged++;
      else result.updated++;
      if (prior?.dedupeKey && prior.dedupeKey !== row.dedupeKey) result.previousDedupeKeys.push(prior.dedupeKey as string);
      store.rows.set(row.externalId, { ...row });
      result.count++;
    }
    return result;
  }),
  closeMissingSnapshotListings: vi.fn(async (_admin: unknown, args: unknown) => {
    store.closeCalls.push(args);
    return store.closeResult;
  }),
}));

vi.mock("@/lib/supabase/queries/sources", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase/queries/sources")>("@/lib/supabase/queries/sources");
  return {
    ...actual,
    resolveJobDuplicates: vi.fn(async (_admin: unknown, keys: Iterable<string>) => {
      store.resolveCalls.push([...keys].sort());
      return 0;
    }),
  };
});

const { computeExpiresAt, isValidListing, runSourceSync, SYNC_SOFT_LIMIT_MS, toExternalUpsert } = await import("@/lib/jobs/sync");
const { SourceHttpError } = await import("@/lib/jobs/sources/http");
const { SourceConfigError, SourceCursorError } = await import("@/lib/jobs/sources/types");
const { TaskError } = await import("@/lib/tasks/errors");

import type { JobSourceAdapter, NormalizedListing } from "@/lib/jobs/sources/types";
import type { JobSourceBoardRow, JobSourceRow } from "@/lib/supabase/queries/sources";

function listing(id: string, overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    externalId: id,
    title: `Data Intern ${id}`,
    company: "Acme Inc",
    descriptionText: `Description ${id}`,
    sourceUrl: `https://source.example/jobs/${id}`,
    applyUrl: null,
    locationText: "New York, NY",
    primaryLocation: { city: "New York", region: "NY", country: "US" },
    locationCountry: "US",
    remoteType: null,
    employmentType: null,
    levelRaw: "Internship",
    postedAt: "2026-11-01T00:00:00.000Z",
    sourceExpiresAt: null,
    salary: null,
    sourceBoard: null,
    sourceMetadata: {},
    ...overrides,
  };
}

const museSource: JobSourceRow = {
  slug: "themuse",
  display_name: "The Muse",
  enabled: true,
  sync_mode: "incremental",
  dedupe_priority: 30,
  default_ttl_days: 60,
  config: {},
  last_run_at: null,
  last_success_at: null,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const ghSource: JobSourceRow = { ...museSource, slug: "greenhouse", sync_mode: "snapshot", dedupe_priority: 10, default_ttl_days: 90 };

const board: JobSourceBoardRow = {
  id: "b0000000-0000-4000-8000-000000000001",
  source_slug: "greenhouse",
  board_token: "acme",
  company_name: "Acme Inc",
  enabled: true,
  include_unlabeled_titles: false,
  last_synced_at: null,
  last_error_code: null,
  consecutive_failures: 0,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

/** Adapter over fixed pages; cursor = page index as a string. */
function pagedAdapter(pages: NormalizedListing[][], overrides: Partial<JobSourceAdapter> = {}) {
  const fetchPage = vi.fn(async ({ cursor }: { cursor: string | null }) => {
    const index = cursor === null ? 0 : Number(cursor);
    const next = index + 1 < pages.length ? String(index + 1) : null;
    return { listings: pages[index], nextCursor: next, complete: next === null };
  });
  const adapter: JobSourceAdapter = {
    slug: "themuse",
    displayName: "Test",
    syncMode: "incremental",
    requiredEnv: [],
    minRequestIntervalMs: 0,
    attribution: null,
    fetchPage,
    ...overrides,
  };
  return { adapter, fetchPage };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function clock(startMs = 1_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

function baseInput(adapter: JobSourceAdapter, c: ReturnType<typeof clock>, overrides: Record<string, unknown> = {}) {
  return {
    admin: {} as never,
    adapter,
    source: museSource,
    board: null,
    cursor: null,
    runStartedAt: "2026-11-16T13:00:00.000Z",
    signal: new AbortController().signal,
    startedAtMs: c.now(),
    log,
    now: c.now,
    sleep: c.sleep,
    ...overrides,
  };
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
});

describe("runSourceSync paging", () => {
  it("pages to the end, upserts every valid listing, resolves touched keys, and reports complete", async () => {
    const c = clock();
    const { adapter, fetchPage } = pagedAdapter([[listing("1"), listing("2")], [listing("3")]]);

    const out = await runSourceSync(baseInput(adapter, c));

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls.map((call) => call[0].cursor)).toEqual([null, "1"]);
    expect(out).toMatchObject({ pagesFetched: 2, complete: true, continuation: null });
    expect(out.counts).toMatchObject({ fetched: 3, inserted: 3, updated: 0, unchanged: 0, skipped_invalid: 0, skipped_filtered: 0 });
    expect([...store.rows.keys()].sort()).toEqual(["1", "2", "3"]);
    expect(store.resolveCalls).toHaveLength(1);
    expect(store.resolveCalls[0]).toHaveLength(3);
    expect(store.closeCalls).toHaveLength(0);
  });

  it("drops invalid listings (no title / description / http(s) link-back / id) and counts them", async () => {
    const c = clock();
    const { adapter } = pagedAdapter([
      [
        listing("ok"),
        listing("no-title", { title: "  " }),
        listing("no-desc", { descriptionText: "" }),
        listing("no-url", { sourceUrl: "" }),
        listing("js-url", { sourceUrl: "javascript:alert(1)" }),
        listing(""),
      ],
    ]);
    const out = await runSourceSync(baseInput(adapter, c));
    expect(out.counts).toMatchObject({ fetched: 6, inserted: 1, skipped_invalid: 5 });
  });

  it("does not apply the student filter to non-board syncs (Muse filters at source)", async () => {
    const c = clock();
    const { adapter } = pagedAdapter([[listing("1", { title: "Senior Staff Engineer" })]]);
    const out = await runSourceSync(baseInput(adapter, c));
    expect(out.counts).toMatchObject({ inserted: 1, skipped_filtered: 0 });
  });

  it("throttles requests to minRequestIntervalMs", async () => {
    const c = clock();
    const { adapter } = pagedAdapter([[listing("1")], [listing("2")], [listing("3")]], { minRequestIntervalMs: 1_000 });
    await runSourceSync(baseInput(adapter, c));
    expect(c.sleep).toHaveBeenCalledTimes(2);
    expect(c.sleep.mock.calls.every(([ms]) => ms > 0 && ms <= 1_000)).toBe(true);
  });
});

describe("runSourceSync continuation (soft limit)", () => {
  it("stops after SYNC_SOFT_LIMIT_MS and returns the next cursor for a continuation task", async () => {
    const c = clock();
    const pages = [[listing("1")], [listing("2")], [listing("3")]];
    const { adapter, fetchPage } = pagedAdapter(pages);
    fetchPage.mockImplementationOnce(async () => {
      c.advance(SYNC_SOFT_LIMIT_MS + 1);
      return { listings: pages[0], nextCursor: "1", complete: false };
    });

    const out = await runSourceSync(baseInput(adapter, c));

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(out.continuation).toEqual({ cursor: "1", runAfterMs: null });
    expect(out.complete).toBe(false);
    expect([...store.rows.keys()]).toEqual(["1"]);
    // Keys from the pages it did fetch are still resolved.
    expect(store.resolveCalls).toHaveLength(1);
  });

  it("is idempotent: re-running a continuation cursor (retry or duplicate task) leaves the same rows and only counts them as unchanged", async () => {
    const pages = [[listing("1"), listing("2")], [listing("3"), listing("4")], [listing("5")]];

    // Chain: task A (first page, then soft limit) → continuation from "1".
    const c1 = clock();
    const { adapter: a1, fetchPage: f1 } = pagedAdapter(pages);
    f1.mockImplementationOnce(async () => {
      c1.advance(SYNC_SOFT_LIMIT_MS);
      return { listings: pages[0], nextCursor: "1", complete: false };
    });
    const first = await runSourceSync(baseInput(a1, c1));
    expect(first.continuation?.cursor).toBe("1");

    const c2 = clock();
    const { adapter: a2 } = pagedAdapter(pages);
    const second = await runSourceSync(baseInput(a2, c2, { cursor: first.continuation?.cursor }));
    const snapshot = JSON.stringify([...store.rows.entries()].sort().map(([id, row]) => [id, { ...row, lastSeenAt: null, expiresAt: null }]));

    // The same continuation runs again (e.g. its task died before complete_task).
    const c3 = clock();
    const { adapter: a3 } = pagedAdapter(pages);
    const replay = await runSourceSync(baseInput(a3, c3, { cursor: first.continuation?.cursor }));

    expect(second.counts).toMatchObject({ fetched: 3, inserted: 3, unchanged: 0 });
    expect(replay.counts).toMatchObject({ fetched: 3, inserted: 0, updated: 0, unchanged: 3 });
    expect(JSON.stringify([...store.rows.entries()].sort().map(([id, row]) => [id, { ...row, lastSeenAt: null, expiresAt: null }]))).toBe(snapshot);
    expect(store.rows.size).toBe(5);
    expect(replay.complete).toBe(true);
    expect(replay.continuation).toBeNull();
  });
});

describe("runSourceSync errors", () => {
  it("honors Retry-After once on HTTP 429, then succeeds", async () => {
    const c = clock();
    const { adapter, fetchPage } = pagedAdapter([[listing("1")]]);
    fetchPage.mockRejectedValueOnce(new SourceHttpError("x returned HTTP 429.", 429, 7));
    const out = await runSourceSync(baseInput(adapter, c));
    expect(c.sleep).toHaveBeenCalledWith(7_000, expect.anything());
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(out.counts.inserted).toBe(1);
  });

  it("caps the Retry-After wait at 60 s and defaults to 30 s without a header", async () => {
    const c = clock();
    const { adapter, fetchPage } = pagedAdapter([[listing("1")], [listing("2")]]);
    fetchPage
      .mockRejectedValueOnce(new SourceHttpError("429", 429, 3600))
      .mockImplementationOnce(async () => ({ listings: [listing("1")], nextCursor: "1", complete: false }))
      .mockRejectedValueOnce(new SourceHttpError("429", 429, null));
    await runSourceSync(baseInput(adapter, c));
    const waits = c.sleep.mock.calls.map(([ms]) => ms);
    expect(waits).toContain(60_000);
    expect(waits).toContain(30_000);
  });

  it("fails with retryable source_unavailable on a second 429 for the same page", async () => {
    const c = clock();
    const { adapter, fetchPage } = pagedAdapter([[listing("1")]]);
    fetchPage.mockRejectedValue(new SourceHttpError("429", 429, 1));
    const err = await runSourceSync(baseInput(adapter, c)).catch((e) => e);
    expect(err).toBeInstanceOf(TaskError);
    expect(err).toMatchObject({ code: "source_unavailable", retryable: true });
  });

  it("continues later instead of waiting when the Retry-After would pass the soft limit", async () => {
    const c = clock();
    const { adapter, fetchPage } = pagedAdapter([[listing("1")], [listing("2")]]);
    fetchPage
      .mockImplementationOnce(async () => {
        c.advance(SYNC_SOFT_LIMIT_MS - 10_000);
        return { listings: [listing("1")], nextCursor: "1", complete: false };
      })
      .mockRejectedValueOnce(new SourceHttpError("429", 429, 45));
    const out = await runSourceSync(baseInput(adapter, c));
    expect(out.continuation).toEqual({ cursor: "1", runAfterMs: c.now() + 45_000 });
    expect(c.sleep).not.toHaveBeenCalledWith(45_000, expect.anything());
  });

  it("maps other HTTP errors to retryable source_unavailable with a PII-free message", async () => {
    const c = clock();
    const { adapter, fetchPage } = pagedAdapter([[listing("1")]]);
    fetchPage.mockRejectedValue(new SourceHttpError("api.example returned HTTP 503.", 503, null));
    const err = await runSourceSync(baseInput(adapter, c)).catch((e) => e);
    expect(err).toMatchObject({ code: "source_unavailable", retryable: true, message: "api.example returned HTTP 503." });
    expect(store.rows.size).toBe(0);
  });

  it("maps a bad cursor to non-retryable unknown_payload and a bad config to non-retryable internal_error", async () => {
    const c = clock();
    const { adapter, fetchPage } = pagedAdapter([[listing("1")]]);
    fetchPage.mockRejectedValueOnce(new SourceCursorError("bad"));
    await expect(runSourceSync(baseInput(adapter, c))).rejects.toMatchObject({ code: "unknown_payload", retryable: false });
    fetchPage.mockRejectedValueOnce(new SourceConfigError("bad"));
    await expect(runSourceSync(baseInput(adapter, c))).rejects.toMatchObject({ code: "internal_error", retryable: false });
  });

  it("lets the task deadline abort propagate unchanged", async () => {
    const c = clock();
    const controller = new AbortController();
    const reason = new Error("deadline");
    const { adapter, fetchPage } = pagedAdapter([[listing("1")]]);
    fetchPage.mockImplementation(async () => {
      controller.abort(reason);
      throw new SourceHttpError("aborted", null, null);
    });
    await expect(runSourceSync(baseInput(adapter, c, { signal: controller.signal }))).rejects.toBeInstanceOf(SourceHttpError);
  });
});

describe("runSourceSync board (snapshot) syncs", () => {
  it("applies the student filter, falls back to the board's company, and snapshot-closes after a complete fetch", async () => {
    const c = clock();
    store.closeResult = { closed: 2, dedupeKeys: ["closedkey"] };
    const { adapter, fetchPage } = pagedAdapter([
      [listing("acme:1", { title: "Software Engineering Intern", company: null }), listing("acme:2", { title: "Senior Engineer" }), listing("acme:3", { title: "Accountant" })],
    ]);

    const out = await runSourceSync(baseInput(adapter, c, { source: ghSource, board }));

    expect(fetchPage.mock.calls[0][0].board).toBe("acme");
    expect(out.counts).toMatchObject({ fetched: 3, inserted: 1, skipped_filtered: 2, closed: 2 });
    const stored = store.rows.get("acme:1");
    expect(stored).toMatchObject({ company: "Acme Inc", sourceBoard: "acme" });
    expect(store.closeCalls).toEqual([
      { source: "greenhouse", sourceBoard: "acme", runStartedAt: "2026-11-16T13:00:00.000Z", signal: expect.anything() },
    ]);
    expect(store.resolveCalls[0]).toContain("closedkey");
  });

  it("keeps unlabeled titles when the board opted in", async () => {
    const c = clock();
    const { adapter } = pagedAdapter([[listing("acme:3", { title: "Accountant" })]]);
    const out = await runSourceSync(baseInput(adapter, c, { source: ghSource, board: { ...board, include_unlabeled_titles: true } }));
    expect(out.counts).toMatchObject({ inserted: 1, skipped_filtered: 0 });
  });

  it("never snapshot-closes after a partial fetch (continuation) or a failure", async () => {
    const c = clock();
    const pages = [[listing("acme:1", { title: "Intern" })], [listing("acme:2", { title: "Intern" })]];
    const { adapter, fetchPage } = pagedAdapter(pages);
    fetchPage.mockImplementationOnce(async () => {
      c.advance(SYNC_SOFT_LIMIT_MS);
      return { listings: pages[0], nextCursor: "1", complete: false };
    });
    await runSourceSync(baseInput(adapter, c, { source: ghSource, board }));
    expect(store.closeCalls).toHaveLength(0);

    const { adapter: failing, fetchPage: failingFetch } = pagedAdapter(pages);
    failingFetch.mockRejectedValue(new SourceHttpError("503", 503, null));
    await expect(runSourceSync(baseInput(failing, clock(), { source: ghSource, board }))).rejects.toBeInstanceOf(TaskError);
    expect(store.closeCalls).toHaveLength(0);
  });

  it("never snapshot-closes when the adapter reports an incomplete last page", async () => {
    const { adapter, fetchPage } = pagedAdapter([[listing("acme:1", { title: "Intern" })]]);
    fetchPage.mockResolvedValueOnce({ listings: [listing("acme:1", { title: "Intern" })], nextCursor: null, complete: false });
    await runSourceSync(baseInput(adapter, clock(), { source: ghSource, board }));
    expect(store.closeCalls).toHaveLength(0);
  });

  it("re-resolves a listing's previous dedupe key when its key changes", async () => {
    const { adapter } = pagedAdapter([[listing("1")]]);
    await runSourceSync(baseInput(adapter, clock()));
    const oldKey = store.rows.get("1")?.dedupeKey as string;
    const { adapter: retitled } = pagedAdapter([[listing("1", { title: "Data Engineering Intern" })]]);
    await runSourceSync(baseInput(retitled, clock()));
    const newKey = store.rows.get("1")?.dedupeKey as string;
    expect(newKey).not.toBe(oldKey);
    expect(store.resolveCalls[1]).toEqual([newKey, oldKey].sort());
  });
});

describe("toExternalUpsert / computeExpiresAt / isValidListing", () => {
  const nowMs = Date.parse("2026-11-16T13:00:00.000Z");

  it("expires_at = source close date when given", () => {
    expect(computeExpiresAt({ postedAt: null, sourceExpiresAt: "2026-12-01T00:00:00Z" }, nowMs, 60)).toBe("2026-12-01T00:00:00.000Z");
  });

  it("expires_at = greatest(postedAt, last_seen_at) + ttl otherwise", () => {
    expect(computeExpiresAt({ postedAt: "2026-10-01T00:00:00Z", sourceExpiresAt: null }, nowMs, 60)).toBe("2027-01-15T13:00:00.000Z");
    expect(computeExpiresAt({ postedAt: "2026-12-01T00:00:00Z", sourceExpiresAt: null }, nowMs, 10)).toBe("2026-12-11T00:00:00.000Z");
    expect(computeExpiresAt({ postedAt: "garbage", sourceExpiresAt: "garbage" }, nowMs, 1)).toBe("2026-11-17T13:00:00.000Z");
  });

  it("maps a listing: last_seen_at = now, dedupe key, normalized currency/country, invalid apply URL dropped", () => {
    const row = toExternalUpsert(
      listing("1", {
        applyUrl: "ftp://nope",
        locationCountry: "us",
        salary: { min: 20, max: Number.NaN, currency: "usd", period: "hour" },
        sourceMetadata: { team: "Data" },
      }),
      { source: museSource, board: null, nowMs },
    );
    expect(row).toMatchObject({
      externalId: "1",
      applyUrl: null,
      locationCountry: "US",
      salaryMin: 20,
      salaryMax: null,
      salaryCurrency: "USD",
      salaryPeriod: "hour",
      lastSeenAt: "2026-11-16T13:00:00.000Z",
      level: "Internship",
      location: "New York, NY",
      sourceMetadata: { team: "Data" },
    });
    expect(row.dedupeKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives a listing without a company no dedupe key", () => {
    expect(toExternalUpsert(listing("1", { company: null }), { source: museSource, board: null, nowMs }).dedupeKey).toBeNull();
  });

  it("validates link-back URLs and ids", () => {
    expect(isValidListing(listing("1"))).toBe(true);
    expect(isValidListing(listing("1", { sourceUrl: "http://ok.example/x" }))).toBe(true);
    expect(isValidListing(listing("1", { sourceUrl: "not a url" }))).toBe(false);
    expect(isValidListing(listing("x".repeat(501)))).toBe(false);
  });
});
