import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchThemuseJobsPage,
  mapThemuseJobToExternalJobDescription,
  stripHtml,
  ThemuseApiError,
} from "@/lib/jobs/themuse";
import {
  JOB_DESCRIPTION_COMPANY_MAX_LENGTH,
  JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_TITLE_MAX_LENGTH,
} from "@/lib/validation/schemas";

describe("stripHtml", () => {
  it("removes tags and preserves paragraph breaks", () => {
    expect(stripHtml("<p>Hello</p><p>World</p>")).toBe("Hello\nWorld");
  });

  it("converts <br> to a newline", () => {
    expect(stripHtml("Line one<br>Line two")).toBe("Line one\nLine two");
  });

  it("converts list items to '- ' bullet lines", () => {
    expect(stripHtml("<ul><li>One</li><li>Two</li></ul>")).toBe(
      "- One\n- Two",
    );
  });

  it("decodes common HTML entities", () => {
    expect(stripHtml("Ben &amp; Jerry&#39;s &lt;3 &quot;ice cream&quot;")).toBe(
      `Ben & Jerry's <3 "ice cream"`,
    );
  });

  it("collapses 3+ blank lines to 2", () => {
    expect(stripHtml("<p>A</p><p></p><p></p><p>B</p>")).toBe("A\n\nB");
  });

  it("trims leading/trailing whitespace", () => {
    expect(stripHtml("  <p>  padded  </p>  ")).toBe("padded");
  });
});

describe("mapThemuseJobToExternalJobDescription", () => {
  const baseRaw = {
    id: 12345,
    name: "Software Engineering Intern",
    contents: "<p>Build things with us.</p>",
    company: { name: "Acme Corp" },
    locations: [{ name: "New York, NY" }, { name: "Remote" }],
    levels: [{ name: "Internship" }],
    publication_date: "2026-09-01T00:00:00Z",
    refs: { landing_page: "https://www.themuse.com/jobs/acme/swe-intern" },
  };

  it("maps a well-formed raw job to the upsert shape", () => {
    const result = mapThemuseJobToExternalJobDescription(baseRaw);

    expect(result).toEqual({
      externalId: "12345",
      title: "Software Engineering Intern",
      company: "Acme Corp",
      description: "Build things with us.",
      sourceUrl: "https://www.themuse.com/jobs/acme/swe-intern",
      level: "Internship",
      location: "New York, NY, Remote",
      postedAt: "2026-09-01T00:00:00Z",
    });
  });

  it("returns null when name is missing", () => {
    expect(
      mapThemuseJobToExternalJobDescription({ ...baseRaw, name: null }),
    ).toBeNull();
  });

  it("returns null when name is empty/whitespace", () => {
    expect(
      mapThemuseJobToExternalJobDescription({ ...baseRaw, name: "   " }),
    ).toBeNull();
  });

  it("returns null when contents is missing", () => {
    expect(
      mapThemuseJobToExternalJobDescription({ ...baseRaw, contents: null }),
    ).toBeNull();
  });

  it("returns null when contents strips down to empty (e.g. only tags)", () => {
    expect(
      mapThemuseJobToExternalJobDescription({ ...baseRaw, contents: "<br>" }),
    ).toBeNull();
  });

  it("defaults company/level/location/sourceUrl/postedAt to null when absent", () => {
    const result = mapThemuseJobToExternalJobDescription({
      id: 1,
      name: "A Job",
      contents: "Do things.",
    });

    expect(result).toEqual({
      externalId: "1",
      title: "A Job",
      company: null,
      description: "Do things.",
      sourceUrl: null,
      level: null,
      location: null,
      postedAt: null,
    });
  });

  it("filters out locations with no name", () => {
    const result = mapThemuseJobToExternalJobDescription({
      ...baseRaw,
      locations: [{ name: "Boston, MA" }, { name: null }],
    });
    expect(result?.location).toBe("Boston, MA");
  });

  it("truncates title/company/description to the shared validation max lengths", () => {
    const result = mapThemuseJobToExternalJobDescription({
      ...baseRaw,
      name: "T".repeat(JOB_DESCRIPTION_TITLE_MAX_LENGTH + 50),
      company: { name: "C".repeat(JOB_DESCRIPTION_COMPANY_MAX_LENGTH + 50) },
      contents: "D".repeat(JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH + 50),
    });

    expect(result?.title).toHaveLength(JOB_DESCRIPTION_TITLE_MAX_LENGTH);
    expect(result?.company).toHaveLength(JOB_DESCRIPTION_COMPANY_MAX_LENGTH);
    expect(result?.description).toHaveLength(
      JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
    );
  });

  it("uses only the first level when multiple are present", () => {
    const result = mapThemuseJobToExternalJobDescription({
      ...baseRaw,
      levels: [{ name: "Internship" }, { name: "Entry Level" }],
    });
    expect(result?.level).toBe("Internship");
  });
});

describe("fetchThemuseJobsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the expected URL with level and page query params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ page: 0, page_count: 3, results: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchThemuseJobsPage("Internship", 2);

    const calledUrl = mockFetch.mock.calls[0][0] as URL;
    expect(calledUrl.toString()).toBe(
      "https://www.themuse.com/api/public/jobs?level=Internship&page=2&sort=publication_date&descending=true",
    );
  });

  it("returns results and pageCount from a successful response", async () => {
    const rawJob = { id: 1, name: "A Job", contents: "text" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ page: 0, page_count: 5, results: [rawJob] }),
      }),
    );

    const result = await fetchThemuseJobsPage("Entry Level", 0);
    expect(result).toEqual({ results: [rawJob], pageCount: 5 });
  });

  it("defaults results to [] when the response omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ page: 0, page_count: 0 }),
      }),
    );

    const result = await fetchThemuseJobsPage("Internship", 0);
    expect(result.results).toEqual([]);
  });

  it("throws ThemuseApiError on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    await expect(fetchThemuseJobsPage("Internship", 0)).rejects.toThrow(
      ThemuseApiError,
    );
  });

  it("throws ThemuseApiError on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    await expect(fetchThemuseJobsPage("Internship", 0)).rejects.toThrow(
      ThemuseApiError,
    );
  });
});
