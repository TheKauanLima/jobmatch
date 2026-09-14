import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFetchThemuseJobsPage, mockUpsertExternalJobDescriptions } =
  vi.hoisted(() => ({
    mockFetchThemuseJobsPage: vi.fn(),
    mockUpsertExternalJobDescriptions: vi.fn(),
  }));

vi.mock("@/lib/jobs/themuse", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/jobs/themuse")>(
      "@/lib/jobs/themuse",
    );
  return {
    ...actual,
    fetchThemuseJobsPage: mockFetchThemuseJobsPage,
  };
});

vi.mock("@/lib/supabase/queries/jobDescriptions", () => ({
  upsertExternalJobDescriptions: mockUpsertExternalJobDescriptions,
}));

const { syncThemuseJobs } = await import("@/lib/jobs/sync");
const { ThemuseApiError } = await import("@/lib/jobs/themuse");

function rawJob(id: number) {
  return { id, name: `Job ${id}`, contents: "Some description text." };
}

const fakeSupabase = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertExternalJobDescriptions.mockResolvedValue({ count: 0 });
});

describe("syncThemuseJobs", () => {
  it("fetches and upserts results for every configured level", async () => {
    mockFetchThemuseJobsPage.mockImplementation(async () => ({
      results: [rawJob(1), rawJob(2)],
      pageCount: 1,
    }));
    mockUpsertExternalJobDescriptions.mockResolvedValue({ count: 2 });

    const result = await syncThemuseJobs(fakeSupabase);

    expect(mockFetchThemuseJobsPage).toHaveBeenCalledWith("Internship", 0);
    expect(mockFetchThemuseJobsPage).toHaveBeenCalledWith("Entry Level", 0);
    expect(mockUpsertExternalJobDescriptions).toHaveBeenCalledTimes(2);
    expect(mockUpsertExternalJobDescriptions).toHaveBeenCalledWith(
      fakeSupabase,
      "themuse",
      expect.arrayContaining([
        expect.objectContaining({ externalId: "1" }),
        expect.objectContaining({ externalId: "2" }),
      ]),
    );
    expect(result.totalUpserted).toBe(4);
    expect(result.levels).toHaveLength(2);
    expect(result.levels[0]).toMatchObject({
      level: "Internship",
      fetched: 2,
      mapped: 2,
      skippedInvalid: 0,
      pagesFetched: 1,
      error: null,
    });
  });

  it("stops paginating a level once page + 1 >= pageCount", async () => {
    mockFetchThemuseJobsPage
      .mockResolvedValueOnce({ results: [rawJob(1)], pageCount: 2 })
      .mockResolvedValueOnce({ results: [rawJob(2)], pageCount: 2 })
      .mockResolvedValue({ results: [rawJob(3)], pageCount: 1 });

    await syncThemuseJobs(fakeSupabase);

    // 2 pages for Internship (pageCount=2), 1 page for Entry Level.
    expect(mockFetchThemuseJobsPage).toHaveBeenCalledTimes(3);
  });

  it("caps pagination at MAX_PAGES_PER_LEVEL even if pageCount is huge", async () => {
    mockFetchThemuseJobsPage.mockResolvedValue({
      results: [rawJob(1)],
      pageCount: 1000,
    });

    await syncThemuseJobs(fakeSupabase);

    // 5 pages/level (MAX_PAGES_PER_LEVEL) * 2 levels.
    expect(mockFetchThemuseJobsPage).toHaveBeenCalledTimes(10);
  });

  it("skips invalid raw jobs (mapper returns null) without upserting them", async () => {
    mockFetchThemuseJobsPage.mockResolvedValue({
      results: [rawJob(1), { id: 2, name: null, contents: "x" }],
      pageCount: 1,
    });

    const result = await syncThemuseJobs(fakeSupabase);

    const internshipResult = result.levels.find(
      (l) => l.level === "Internship",
    );
    expect(internshipResult?.fetched).toBe(2);
    expect(internshipResult?.mapped).toBe(1);
    expect(internshipResult?.skippedInvalid).toBe(1);
  });

  it("records a fetch error for a level and continues to the next level (does not abort the whole run)", async () => {
    mockFetchThemuseJobsPage.mockImplementation(async (level: string) => {
      if (level === "Internship") {
        throw new ThemuseApiError("The Muse API returned 503");
      }
      return { results: [rawJob(1)], pageCount: 1 };
    });
    mockUpsertExternalJobDescriptions.mockResolvedValue({ count: 1 });

    const result = await syncThemuseJobs(fakeSupabase);

    const internship = result.levels.find((l) => l.level === "Internship");
    const entryLevel = result.levels.find((l) => l.level === "Entry Level");

    expect(internship?.error).toBe("The Muse API returned 503");
    expect(internship?.mapped).toBe(0);
    expect(entryLevel?.error).toBeNull();
    expect(entryLevel?.mapped).toBe(1);
    expect(result.totalUpserted).toBe(1);
  });

  it("records an upsert error without throwing", async () => {
    mockFetchThemuseJobsPage.mockResolvedValue({
      results: [rawJob(1)],
      pageCount: 1,
    });
    mockUpsertExternalJobDescriptions.mockRejectedValue(
      new Error("db unavailable"),
    );

    const result = await syncThemuseJobs(fakeSupabase);

    expect(result.levels[0].error).toBe("db unavailable");
    expect(result.totalUpserted).toBe(0);
  });

  it("does not call upsert for a level with zero mapped rows", async () => {
    mockFetchThemuseJobsPage.mockResolvedValue({ results: [], pageCount: 1 });

    await syncThemuseJobs(fakeSupabase);

    expect(mockUpsertExternalJobDescriptions).not.toHaveBeenCalled();
  });
});
