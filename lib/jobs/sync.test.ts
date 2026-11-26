import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFetchGreenhouseBoard,
  mockFetchLeverBoard,
  mockUpsert,
  mockSoftDelete,
} = vi.hoisted(() => ({
  mockFetchGreenhouseBoard: vi.fn(),
  mockFetchLeverBoard: vi.fn(),
  mockUpsert: vi.fn(),
  mockSoftDelete: vi.fn(),
}));

vi.mock("@/lib/jobs/sources/greenhouse", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/jobs/sources/greenhouse")
  >("@/lib/jobs/sources/greenhouse");
  return { ...actual, fetchGreenhouseBoard: mockFetchGreenhouseBoard };
});

vi.mock("@/lib/jobs/sources/lever", async () => {
  const actual = await vi.importActual<typeof import("@/lib/jobs/sources/lever")>(
    "@/lib/jobs/sources/lever",
  );
  return { ...actual, fetchLeverBoard: mockFetchLeverBoard };
});

vi.mock("@/lib/supabase/queries/jobDescriptions", async () => ({
  // The real constants are needed: lib/validation/schemas.ts imports them (§7.8.6).
  ...(await vi.importActual<typeof import("@/lib/supabase/queries/jobDescriptions")>(
    "@/lib/supabase/queries/jobDescriptions",
  )),
  upsertExternalJobDescriptions: mockUpsert,
  softDeleteMissingExternalJobDescriptions: mockSoftDelete,
}));

const { syncExternalJobs, RUN_BUDGET_MS, SYNC_CONCURRENCY, REQUEST_TIMEOUT_MS } =
  await import("@/lib/jobs/sync");
const { JobBoardFetchError } = await import("@/lib/jobs/sources/common");

import type { JobBoardCompany } from "@/lib/jobs/sources/companies";

const fakeSupabase = {} as never;

function gh(token: string): JobBoardCompany {
  return { provider: "greenhouse", token, displayName: token.toUpperCase() };
}
function lv(token: string): JobBoardCompany {
  return { provider: "lever", token, displayName: token.toUpperCase() };
}

function ghJob(id: number, title = "Software Engineer Intern") {
  return {
    id,
    title,
    location: { name: "New York, NY" },
    absolute_url: `https://job-boards.greenhouse.io/x/jobs/${id}`,
    content: "&lt;p&gt;Do things.&lt;/p&gt;",
    first_published: "2026-11-01T00:00:00Z",
  };
}

function lvPosting(id: string, text = "Data Science Intern") {
  return {
    id,
    text,
    categories: { location: "Austin, TX" },
    country: "US",
    descriptionPlain: "Role.",
    hostedUrl: `https://jobs.lever.co/x/${id}`,
    createdAt: 1_794_006_857_184,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsert.mockImplementation(async (_s, _p, rows: unknown[]) => ({
    count: rows.length,
  }));
  mockSoftDelete.mockResolvedValue({ count: 0 });
  mockFetchGreenhouseBoard.mockResolvedValue([]);
  mockFetchLeverBoard.mockResolvedValue([]);
});

describe("syncExternalJobs", () => {
  it("fetches, filters, upserts and closes each company, routing by provider", async () => {
    mockFetchGreenhouseBoard.mockResolvedValue([
      ghJob(1),
      ghJob(2, "Senior Software Engineer"),
    ]);
    mockFetchLeverBoard.mockResolvedValue([lvPosting("a")]);
    mockSoftDelete.mockResolvedValue({ count: 3 });

    const result = await syncExternalJobs(fakeSupabase, {
      companies: [gh("acme"), lv("zed")],
    });

    expect(mockFetchGreenhouseBoard).toHaveBeenCalledWith("acme", expect.any(AbortSignal));
    expect(mockFetchLeverBoard).toHaveBeenCalledWith("zed", expect.any(AbortSignal));
    expect(mockUpsert).toHaveBeenCalledWith(fakeSupabase, "greenhouse", [
      expect.objectContaining({ externalId: "acme:1", company: "ACME", level: "Internship" }),
    ]);
    expect(mockUpsert).toHaveBeenCalledWith(fakeSupabase, "lever", [
      expect.objectContaining({ externalId: "zed:a", company: "ZED" }),
    ]);
    expect(result.companies).toEqual([
      {
        provider: "greenhouse",
        token: "acme",
        status: "ok",
        fetched: 2,
        kept: 1,
        upserted: 1,
        softDeleted: 3,
        error: null,
      },
      {
        provider: "lever",
        token: "zed",
        status: "ok",
        fetched: 1,
        kept: 1,
        upserted: 1,
        softDeleted: 3,
        error: null,
      },
    ]);
    expect(result.totalUpserted).toBe(2);
    expect(result.totalSoftDeleted).toBe(6);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("soft-deletes against the UNFILTERED board id set (filtered-out jobs still count as present)", async () => {
    mockFetchGreenhouseBoard.mockResolvedValue([
      ghJob(1),
      ghJob(2, "Senior Software Engineer"),
      ghJob(3, "Account Executive"),
      { ...ghJob(4), location: { name: "London, United Kingdom" } },
    ]);

    await syncExternalJobs(fakeSupabase, { companies: [gh("acme")] });

    expect(mockSoftDelete).toHaveBeenCalledTimes(1);
    const [, source, token, ids] = mockSoftDelete.mock.calls[0];
    expect(source).toBe("greenhouse");
    expect(token).toBe("acme");
    expect([...(ids as Set<string>)].sort()).toEqual([
      "acme:1",
      "acme:2",
      "acme:3",
      "acme:4",
    ]);
  });

  it("upserts a duplicated externalId only once", async () => {
    mockFetchGreenhouseBoard.mockResolvedValue([ghJob(7), ghJob(7)]);

    const result = await syncExternalJobs(fakeSupabase, { companies: [gh("acme")] });

    const rows = mockUpsert.mock.calls[0][2] as { externalId: string }[];
    expect(rows.map((r) => r.externalId)).toEqual(["acme:7"]);
    expect(result.companies[0]).toMatchObject({ fetched: 2, kept: 1 });
  });

  it("closes all of a company's rows when its board returns 200 with zero jobs", async () => {
    mockFetchGreenhouseBoard.mockResolvedValue([]);

    const result = await syncExternalJobs(fakeSupabase, { companies: [gh("acme")] });

    expect(mockSoftDelete).toHaveBeenCalledWith(fakeSupabase, "greenhouse", "acme", new Set());
    expect(result.companies[0].status).toBe("ok");
  });

  it("reports a 404 as not_found, skips that company's upsert and soft-delete, and continues with the others", async () => {
    mockFetchGreenhouseBoard.mockImplementation(async (token: string) => {
      if (token === "gone") throw new JobBoardFetchError("greenhouse", "gone", 404, "http");
      return [ghJob(1)];
    });

    const result = await syncExternalJobs(fakeSupabase, {
      companies: [gh("gone"), gh("acme")],
    });

    expect(result.companies[0]).toEqual({
      provider: "greenhouse",
      token: "gone",
      status: "not_found",
      fetched: 0,
      kept: 0,
      upserted: 0,
      softDeleted: 0,
      error: 'greenhouse board "gone" returned HTTP 404',
    });
    expect(result.companies[1].status).toBe("ok");
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockSoftDelete).toHaveBeenCalledTimes(1);
    expect(mockSoftDelete.mock.calls[0][2]).toBe("acme");
  });

  it.each([
    ["a 500", new JobBoardFetchError("lever", "bad", 500, "http"), 'lever board "bad" returned HTTP 500'],
    ["a 429", new JobBoardFetchError("lever", "bad", 429, "http"), 'lever board "bad" returned HTTP 429'],
    ["a timeout", new JobBoardFetchError("lever", "bad", null, "timeout"), 'lever board "bad" timed out'],
    ["a network error", new JobBoardFetchError("lever", "bad", null, "network"), 'lever board "bad" network error'],
    ["a bad body", new JobBoardFetchError("lever", "bad", null, "invalid_body"), 'lever board "bad" returned an unexpected response body'],
    ["an unexpected throw", new Error("raw provider text <html>secret</html>"), 'lever board "bad" failed'],
  ])("reports %s as error with no soft-delete and no retry", async (_label, err, message) => {
    mockFetchLeverBoard.mockRejectedValue(err);

    const result = await syncExternalJobs(fakeSupabase, { companies: [lv("bad")] });

    expect(result.companies[0]).toMatchObject({ status: "error", error: message });
    expect(mockFetchLeverBoard).toHaveBeenCalledTimes(1);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("does not soft-delete when the upsert throws, and keeps DB error text out of the result", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchGreenhouseBoard.mockResolvedValue([ghJob(1)]);
    mockUpsert.mockRejectedValue(new Error("db unavailable: detail"));

    const result = await syncExternalJobs(fakeSupabase, { companies: [gh("acme")] });

    expect(result.companies[0]).toMatchObject({
      status: "error",
      upserted: 0,
      softDeleted: 0,
      error: 'greenhouse board "acme": saving listings failed',
    });
    expect(mockSoftDelete).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("reports a soft-delete failure as error but keeps the upsert count", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchGreenhouseBoard.mockResolvedValue([ghJob(1)]);
    mockSoftDelete.mockRejectedValue(new Error("boom"));

    const result = await syncExternalJobs(fakeSupabase, { companies: [gh("acme")] });

    expect(result.companies[0]).toMatchObject({
      status: "error",
      upserted: 1,
      error: 'greenhouse board "acme": closing removed listings failed',
    });
    expect(result.totalUpserted).toBe(1);
    consoleError.mockRestore();
  });

  it("starts no new fetch once RUN_BUDGET_MS has passed and reports the rest as skipped_time_budget", async () => {
    let clock = 0;
    mockFetchGreenhouseBoard.mockImplementation(async () => {
      // Each fetch start advances the clock, so the budget is exactly used up
      // once SYNC_CONCURRENCY fetches have started.
      clock += RUN_BUDGET_MS / SYNC_CONCURRENCY;
      return [ghJob(1)];
    });
    const companies = ["a", "b", "c", "d", "e", "f"].map(gh);

    const result = await syncExternalJobs(fakeSupabase, {
      companies,
      now: () => clock,
    });

    // The first SYNC_CONCURRENCY fetches start before the budget is reached;
    // after that the clock is at the budget, so nothing else starts.
    expect(mockFetchGreenhouseBoard).toHaveBeenCalledTimes(SYNC_CONCURRENCY);
    expect(result.companies.map((c) => c.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "skipped_time_budget",
      "skipped_time_budget",
    ]);
    expect(result.companies[5]).toEqual({
      provider: "greenhouse",
      token: "f",
      status: "skipped_time_budget",
      fetched: 0,
      kept: 0,
      upserted: 0,
      softDeleted: 0,
      error: null,
    });
    // Skipped companies are never soft-deleted.
    expect(mockSoftDelete).toHaveBeenCalledTimes(SYNC_CONCURRENCY);
    expect(result.durationMs).toBe(clock);
  });

  it(`never runs more than SYNC_CONCURRENCY (${SYNC_CONCURRENCY}) fetches at once, and returns results in input order`, async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockFetchGreenhouseBoard.mockImplementation(async (token: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, token.charCodeAt(0) % 3));
      inFlight--;
      return [];
    });
    const companies = "abcdefghij".split("").map(gh);

    const result = await syncExternalJobs(fakeSupabase, { companies });

    expect(maxInFlight).toBe(SYNC_CONCURRENCY);
    expect(result.companies.map((c) => c.token)).toEqual("abcdefghij".split(""));
  });

  it("gives each fetch its own timeout signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await syncExternalJobs(fakeSupabase, { companies: [gh("a"), lv("b")] });

    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });

  it("never puts a provider response body into the result", async () => {
    // A real 4xx/5xx body never reaches an error message (see the provider
    // tests); here every failure path's result is checked for leakage.
    const BODY = "<html>Just a moment... cf-ray SECRET</html>";
    mockFetchGreenhouseBoard.mockRejectedValue(new Error(BODY));
    mockFetchLeverBoard.mockRejectedValue(
      Object.assign(new JobBoardFetchError("lever", "b", 403, "http"), { body: BODY }),
    );

    const result = await syncExternalJobs(fakeSupabase, { companies: [gh("a"), lv("b")] });

    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("Just a moment");
  });

  it("defaults to the checked-in JOB_BOARD_COMPANIES list", async () => {
    const { JOB_BOARD_COMPANIES } = await import("@/lib/jobs/sources/companies");

    const result = await syncExternalJobs(fakeSupabase);

    expect(result.companies).toHaveLength(JOB_BOARD_COMPANIES.length);
  });
});

describe("syncExternalJobs: QA probes (2026-11-20)", () => {
  it("a job that is unmappable (no title/url/content) still counts as present for the soft-delete", async () => {
    mockFetchGreenhouseBoard.mockResolvedValue([
      ghJob(1),
      { id: 2 },
      { ...ghJob(3), absolute_url: "javascript:alert(1)" },
      { ...ghJob(4), content: "" },
      { title: "No id intern" },
    ]);

    const result = await syncExternalJobs(fakeSupabase, { companies: [gh("acme")] });

    expect(result.companies[0]).toMatchObject({ status: "ok", fetched: 5, kept: 1 });
    const ids = mockSoftDelete.mock.calls[0][3] as Set<string>;
    expect([...ids].sort()).toEqual(["acme:1", "acme:2", "acme:3", "acme:4"]);
  });

  it("the live Toronto bug: a 'Toronto, ON, CA' job is no longer upserted, but (by design) it stays present so a rerun will NOT close an already-imported row", async () => {
    mockFetchGreenhouseBoard.mockResolvedValue([
      ghJob(1),
      {
        ...ghJob(8138080, "Machine Learning Intern 2027 (Toronto)"),
        location: { name: "Toronto, ON, CA" },
      },
    ]);

    await syncExternalJobs(fakeSupabase, { companies: [gh("pinterest")] });

    const rows = mockUpsert.mock.calls[0][2] as { externalId: string }[];
    expect(rows.map((r) => r.externalId)).toEqual(["pinterest:1"]);
    const ids = mockSoftDelete.mock.calls[0][3] as Set<string>;
    expect(ids.has("pinterest:8138080")).toBe(true);
  });

  it("an unexpected throw while mapping one company's jobs skips its upsert/soft-delete and does not affect the others", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const poisoned = ghJob(1);
    Object.defineProperty(poisoned, "title", {
      get() {
        throw new Error("raw payload text that must not leak");
      },
    });
    mockFetchGreenhouseBoard.mockImplementation(async (token: string) =>
      token === "bad" ? [poisoned] : [ghJob(2)],
    );

    const result = await syncExternalJobs(fakeSupabase, {
      companies: [gh("bad"), gh("good")],
    });

    expect(result.companies[0]).toMatchObject({
      token: "bad",
      status: "error",
      error: 'greenhouse board "bad" failed',
    });
    expect(result.companies[1]).toMatchObject({ token: "good", status: "ok", upserted: 1 });
    expect(mockSoftDelete).toHaveBeenCalledTimes(1);
    expect(mockSoftDelete.mock.calls[0][2]).toBe("good");
    expect(JSON.stringify(result)).not.toContain("must not leak");
    consoleError.mockRestore();
  });

  it("does not soft-delete after a 404, and a 404 on one provider doesn't stop the other provider", async () => {
    mockFetchGreenhouseBoard.mockRejectedValue(
      new JobBoardFetchError("greenhouse", "gone", 404, "http"),
    );
    mockFetchLeverBoard.mockResolvedValue([lvPosting("p1")]);

    const result = await syncExternalJobs(fakeSupabase, {
      companies: [gh("gone"), lv("alive")],
    });

    expect(result.companies.map((c) => c.status)).toEqual(["not_found", "ok"]);
    expect(mockSoftDelete).toHaveBeenCalledTimes(1);
    expect(mockSoftDelete.mock.calls[0][1]).toBe("lever");
    expect(result.totalUpserted).toBe(1);
  });

  it("a company already in flight when the budget expires still completes (incl. soft-delete)", async () => {
    let clock = 0;
    mockFetchGreenhouseBoard.mockImplementation(async () => {
      clock = RUN_BUDGET_MS + 5_000;
      return [ghJob(1)];
    });

    const result = await syncExternalJobs(fakeSupabase, {
      companies: [gh("a")],
      now: () => clock,
    });

    expect(result.companies[0]).toMatchObject({ status: "ok", upserted: 1 });
    expect(mockSoftDelete).toHaveBeenCalledTimes(1);
  });
});
