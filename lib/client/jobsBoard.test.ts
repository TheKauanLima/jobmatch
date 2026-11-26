import { describe, expect, it } from "vitest";

import {
  buildFieldOptions,
  buildJobsApiPath,
  buildJobsHref,
  buildLocationOptions,
  displayHost,
  EMPTY_JOBS_QUERY,
  formatAbsoluteDate,
  formatRelativeDays,
  formatResultSummary,
  getJobSourceInfo,
  hasActiveJobsQuery,
  isJobLevelFilter,
  JOB_LEVEL_FILTERS,
  jobPostedAt,
  jobsQueryKey,
  JOBS_SEARCH_MAX_LENGTH,
  JOBS_SORT_OPTIONS,
  listActiveJobsFilters,
  makeSnippet,
  NO_LISTINGS_SUFFIX,
  parseJobLocationFilter,
  parseJobsFacets,
  parseJobsSearchParams,
  withJobsParam,
  type JobsBoardQuery,
  type JobsFacets,
  safeExternalUrl,
  toDescriptionBlocks,
  toPlainText,
} from "@/lib/client/jobsBoard";
import { JOB_CATEGORIES, JOB_CATEGORY_SLUGS } from "@/lib/jobs/categories";
import { JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH } from "@/lib/supabase/queries/jobDescriptions";
import {
  JOB_DESCRIPTION_LEVELS,
  jobDescriptionListQuerySchema,
} from "@/lib/validation/schemas";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const Q = (overrides: Partial<JobsBoardQuery> = {}): JobsBoardQuery => ({
  ...EMPTY_JOBS_QUERY,
  ...overrides,
});

function parseHref(href: string): JobsBoardQuery {
  return parseJobsSearchParams(
    Object.fromEntries(new URL(href, "https://x.test").searchParams),
  );
}

describe("URL state", () => {
  it("stays in sync with the API's search length cap and level vocabulary", () => {
    expect(JOBS_SEARCH_MAX_LENGTH).toBe(JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH);
    for (const level of JOB_LEVEL_FILTERS) {
      expect(JOB_DESCRIPTION_LEVELS).toContain(level);
    }
  });

  it("isJobLevelFilter accepts only the offered levels", () => {
    expect(isJobLevelFilter("Internship")).toBe(true);
    expect(isJobLevelFilter("Entry Level")).toBe(true);
    expect(isJobLevelFilter("Senior Level")).toBe(false);
    expect(isJobLevelFilter("internship")).toBe(false);
    expect(isJobLevelFilter(undefined)).toBe(false);
    expect(isJobLevelFilter(3)).toBe(false);
  });

  describe("parseJobLocationFilter", () => {
    it("normalizes remote and state codes, case-insensitively", () => {
      expect(parseJobLocationFilter("remote")).toBe("remote");
      expect(parseJobLocationFilter("REMOTE")).toBe("remote");
      expect(parseJobLocationFilter(" Remote ")).toBe("remote");
      expect(parseJobLocationFilter("ca")).toBe("CA");
      expect(parseJobLocationFilter("dc")).toBe("DC");
      expect(parseJobLocationFilter("NY")).toBe("NY");
    });

    it("drops anything else", () => {
      expect(parseJobLocationFilter("ON")).toBeNull();
      expect(parseJobLocationFilter("California")).toBeNull();
      expect(parseJobLocationFilter("US")).toBeNull();
      expect(parseJobLocationFilter("")).toBeNull();
      expect(parseJobLocationFilter(undefined)).toBeNull();
    });
  });

  describe("parseJobsSearchParams", () => {
    it("returns empty state for no params", () => {
      expect(parseJobsSearchParams({})).toEqual(EMPTY_JOBS_QUERY);
    });

    it("trims the search and treats blank as none", () => {
      expect(parseJobsSearchParams({ q: "  react  " }).q).toBe("react");
      expect(parseJobsSearchParams({ q: "   " }).q).toBeNull();
      expect(parseJobsSearchParams({ q: "" }).q).toBeNull();
    });

    it("clamps an over-long search to the API cap", () => {
      const q = parseJobsSearchParams({ q: "a".repeat(500) }).q;
      expect(q).toHaveLength(JOBS_SEARCH_MAX_LENGTH);
    });

    it("does not leave trailing whitespace after clamping", () => {
      const q = parseJobsSearchParams({ q: `${"a".repeat(199)} b` }).q;
      expect(q).toBe("a".repeat(199));
    });

    it("keeps known levels and ignores unknown ones", () => {
      expect(parseJobsSearchParams({ level: "Internship" }).level).toBe("Internship");
      expect(parseJobsSearchParams({ level: "Entry Level" }).level).toBe("Entry Level");
      expect(parseJobsSearchParams({ level: "CEO" }).level).toBeNull();
      expect(parseJobsSearchParams({ level: "" }).level).toBeNull();
    });

    it("keeps known field slugs and drops unknown ones", () => {
      for (const slug of JOB_CATEGORY_SLUGS) {
        expect(parseJobsSearchParams({ category: slug }).category).toBe(slug);
      }
      expect(parseJobsSearchParams({ category: "Software" }).category).toBeNull();
      expect(parseJobsSearchParams({ category: "astronaut" }).category).toBeNull();
      expect(parseJobsSearchParams({ category: "" }).category).toBeNull();
    });

    it("normalizes location and drops invalid values", () => {
      expect(parseJobsSearchParams({ location: "Remote" }).location).toBe("remote");
      expect(parseJobsSearchParams({ location: "tx" }).location).toBe("TX");
      expect(parseJobsSearchParams({ location: "Texas" }).location).toBeNull();
      expect(parseJobsSearchParams({ location: "remote,CA" }).location).toBeNull();
    });

    it("keeps sort only as 'recent' alongside a search term", () => {
      expect(parseJobsSearchParams({ q: "go", sort: "recent" }).sort).toBe("recent");
      // relevance is the default with q: not stored.
      expect(parseJobsSearchParams({ q: "go", sort: "relevance" }).sort).toBeNull();
      // No sort without q (the board is always newest first then).
      expect(parseJobsSearchParams({ sort: "recent" }).sort).toBeNull();
      expect(parseJobsSearchParams({ q: "  ", sort: "recent" }).sort).toBeNull();
      expect(parseJobsSearchParams({ q: "go", sort: "oldest" }).sort).toBeNull();
    });

    it("never throws on a messy link: invalid values are just dropped", () => {
      expect(
        parseJobsSearchParams({
          q: "designer",
          level: "Senior",
          category: "nope",
          location: "Atlantis",
          sort: "random",
          cursor: "x",
        }),
      ).toEqual(Q({ q: "designer" }));
    });

    it("uses the first value of repeated params", () => {
      expect(
        parseJobsSearchParams({
          q: ["first", "second"],
          level: ["Internship", "CEO"],
          category: ["data", "software"],
          location: ["remote", "CA"],
        }),
      ).toEqual(Q({ q: "first", level: "Internship", category: "data", location: "remote" }));
    });
  });

  describe("buildJobsHref", () => {
    it("drops empty values", () => {
      expect(buildJobsHref()).toBe("/jobs");
      expect(buildJobsHref(EMPTY_JOBS_QUERY)).toBe("/jobs");
      expect(buildJobsHref({ q: "   " })).toBe("/jobs");
    });

    it("encodes search and level", () => {
      expect(buildJobsHref({ q: "data & ml", level: "Entry Level" })).toBe(
        "/jobs?q=data+%26+ml&level=Entry+Level",
      );
      expect(buildJobsHref({ level: "Internship" })).toBe("/jobs?level=Internship");
    });

    it("writes every filter in a fixed order", () => {
      expect(
        buildJobsHref({
          q: "react",
          level: "Internship",
          category: "software",
          location: "CA",
          sort: "recent",
        }),
      ).toBe("/jobs?q=react&level=Internship&category=software&location=CA&sort=recent");
      expect(buildJobsHref({ category: "people-hr", location: "remote" })).toBe(
        "/jobs?category=people-hr&location=remote",
      );
    });

    it("writes sort only when it's non-default (recent, with a search)", () => {
      expect(buildJobsHref({ sort: "recent" })).toBe("/jobs");
      expect(buildJobsHref({ q: "  ", sort: "recent" })).toBe("/jobs");
      expect(buildJobsHref({ q: "go", sort: null })).toBe("/jobs?q=go");
    });

    it.each([
      Q(),
      Q({ q: "product designer", level: "Internship" }),
      Q({ category: "data" }),
      Q({ location: "remote" }),
      Q({ location: "DC", category: "legal", level: "Entry Level" }),
      Q({ q: "c++ & rust", sort: "recent", location: "WA" }),
      Q({ q: "nurse", level: "Internship", category: "healthcare", location: "TX", sort: "recent" }),
    ])("round-trips through parseJobsSearchParams: %j", (state) => {
      expect(parseHref(buildJobsHref(state))).toEqual(state);
    });
  });

  describe("withJobsParam", () => {
    const base = Q({ q: "react", level: "Internship", category: "software", location: "CA" });

    it("replaces one param and keeps every other", () => {
      expect(withJobsParam(base, "location", "remote")).toEqual({ ...base, location: "remote" });
      expect(withJobsParam(base, "category", "data")).toEqual({ ...base, category: "data" });
      expect(withJobsParam(base, "sort", "recent")).toEqual({ ...base, sort: "recent" });
    });

    it("treats an empty value as 'any'", () => {
      expect(withJobsParam(base, "category", "")).toEqual({ ...base, category: null });
      expect(withJobsParam(base, "location", "")).toEqual({ ...base, location: null });
    });

    it("maps 'Best match' back to the default and drops bad values", () => {
      expect(withJobsParam({ ...base, sort: "recent" }, "sort", "relevance").sort).toBeNull();
      expect(withJobsParam(base, "category", "<script>").category).toBeNull();
    });

    it("normalizes a lowercase state", () => {
      expect(withJobsParam(Q(), "location", "ny").location).toBe("NY");
    });
  });

  it("hasActiveJobsQuery is true for any search or filter, not for sort alone", () => {
    expect(hasActiveJobsQuery(Q())).toBe(false);
    expect(hasActiveJobsQuery(Q({ q: "x" }))).toBe(true);
    expect(hasActiveJobsQuery(Q({ level: "Internship" }))).toBe(true);
    expect(hasActiveJobsQuery(Q({ category: "design" }))).toBe(true);
    expect(hasActiveJobsQuery(Q({ location: "remote" }))).toBe(true);
    expect(hasActiveJobsQuery(Q({ sort: "recent" }))).toBe(false);
  });

  it("jobsQueryKey distinguishes every query combination", () => {
    const queries = [
      Q(),
      Q({ q: "a" }),
      Q({ level: "Internship" }),
      Q({ q: "a", level: "Internship" }),
      Q({ category: "data" }),
      Q({ category: "software" }),
      Q({ location: "remote" }),
      Q({ location: "CA" }),
      Q({ q: "a", sort: "recent" }),
      Q({ q: "a:b" }),
      Q({ q: "b", category: "data", location: "CA" }),
    ];
    expect(new Set(queries.map(jobsQueryKey)).size).toBe(queries.length);
  });

  it("jobsQueryKey ignores a sort that has no effect (no search)", () => {
    expect(jobsQueryKey(Q({ sort: "recent" }))).toBe(jobsQueryKey(Q()));
  });

  it("buildJobsApiPath passes every filter and the cursor through", () => {
    expect(buildJobsApiPath(Q())).toBe("/api/job-descriptions");
    expect(buildJobsApiPath(Q({ q: "go", level: "Internship" }), "offset_20")).toBe(
      "/api/job-descriptions?q=go&level=Internship&cursor=offset_20",
    );
    expect(
      buildJobsApiPath(
        Q({ q: "go", category: "data", location: "remote", sort: "recent" }),
        "offset_40",
      ),
    ).toBe(
      "/api/job-descriptions?q=go&category=data&location=remote&sort=recent&cursor=offset_40",
    );
    // Never sends relevance-without-q (the API answers 400) or sort without q.
    expect(buildJobsApiPath(Q({ sort: "recent", location: "NY" }))).toBe(
      "/api/job-descriptions?location=NY",
    );
  });

  it.each([
    "/jobs",
    "/jobs?sort=recent",
    "/jobs?q=go&sort=relevance",
    "/jobs?level=CEO&category=x&location=zz",
    "/jobs?q=data&level=Entry+Level&category=data&location=ca&sort=recent",
    "/jobs?location=Remote&category=trades",
  ])("any /jobs URL yields an API path the API accepts: %s", (href) => {
    const apiPath = buildJobsApiPath(parseHref(href), "offset_20");
    const params = Object.fromEntries(new URL(apiPath, "https://x.test").searchParams);
    expect(jobDescriptionListQuerySchema.safeParse(params).success).toBe(true);
  });
});

describe("formatResultSummary", () => {
  it("shows an exact count on the last page, newest first without a search", () => {
    expect(formatResultSummary({ count: 1, hasMore: false, ...Q() })).toBe(
      "1 job · Newest first",
    );
    expect(formatResultSummary({ count: 7, hasMore: false, ...Q() })).toBe(
      "7 jobs · Newest first",
    );
  });

  it("shows N+ when more pages exist (no total from the API)", () => {
    expect(formatResultSummary({ count: 20, hasMore: true, ...Q() })).toBe(
      "20+ jobs · Newest first",
    );
  });

  it("mentions the level and search term; best match isn't announced", () => {
    expect(
      formatResultSummary({ count: 3, hasMore: false, ...Q({ q: "react", level: "Internship" }) }),
    ).toBe("3 internship jobs matching “react”");
  });

  it("names the order when a search is sorted by most recent", () => {
    expect(
      formatResultSummary({ count: 3, hasMore: false, ...Q({ q: "react", sort: "recent" }) }),
    ).toBe("3 jobs matching “react” · Newest first");
  });

  it("lists the field and location", () => {
    expect(
      formatResultSummary({
        count: 20,
        hasMore: true,
        ...Q({ level: "Internship", category: "data", location: "remote" }),
      }),
    ).toBe("20+ internship jobs · Data & AI · Remote · Newest first");
    expect(
      formatResultSummary({ count: 2, hasMore: false, ...Q({ q: "nurse", location: "CA" }) }),
    ).toBe("2 jobs matching “nurse” · California");
  });
});

describe("filter options", () => {
  const facets: JobsFacets = {
    categories: { software: 120, data: 30, "people-hr": 2 },
    states: { CA: 50, NY: 20, DC: 3, TX: 1 },
    remote: 40,
  };

  describe("parseJobsFacets", () => {
    it("accepts the documented shape", () => {
      expect(parseJobsFacets(facets)).toEqual(facets);
    });

    it("drops unknown keys and non-positive or non-numeric counts", () => {
      expect(
        parseJobsFacets({
          categories: { software: 3, astronaut: 9, data: 0, design: "4" },
          states: { CA: 2, ON: 5, NY: -1 },
          remote: "7",
        }),
      ).toEqual({ categories: { software: 3 }, states: { CA: 2 }, remote: 0 });
    });

    it("returns null for anything else (treated like a failed request)", () => {
      expect(parseJobsFacets(null)).toBeNull();
      expect(parseJobsFacets({ error: "Failed to load job filters." })).toBeNull();
      expect(parseJobsFacets({ categories: [], states: {} })).toBeNull();
      expect(parseJobsFacets([])).toBeNull();
    });
  });

  describe("buildFieldOptions", () => {
    it("lists 'All fields' then every field in list order", () => {
      const options = buildFieldOptions(facets, null);
      expect(options[0]).toEqual({ value: "", label: "All fields" });
      expect(options.slice(1).map((o) => o.value)).toEqual([...JOB_CATEGORY_SLUGS]);
      expect(options).toHaveLength(JOB_CATEGORIES.length + 1);
    });

    it("disables fields with no listings and says so", () => {
      const options = buildFieldOptions(facets, null);
      const byValue = Object.fromEntries(options.map((o) => [o.value, o]));
      expect(byValue.software).toEqual({
        value: "software",
        label: "Software Engineering",
        disabled: false,
      });
      expect(byValue.trades).toEqual({
        value: "trades",
        label: `Skilled Trades & Construction${NO_LISTINGS_SUFFIX}`,
        disabled: true,
      });
      expect(NO_LISTINGS_SUFFIX).toBe(" (no listings yet)");
      expect(options.filter((o) => o.disabled)).toHaveLength(JOB_CATEGORIES.length - 3);
    });

    it("never disables the selected field (deep link to an empty field)", () => {
      const legal = buildFieldOptions(facets, "legal").find((o) => o.value === "legal");
      expect(legal?.disabled).toBe(false);
      expect(legal?.label).toBe(`Legal & Policy${NO_LISTINGS_SUFFIX}`);
    });

    it("enables every field when facets failed", () => {
      const options = buildFieldOptions(null, null);
      expect(options.some((o) => o.disabled)).toBe(false);
      expect(options.some((o) => o.label.includes(NO_LISTINGS_SUFFIX))).toBe(false);
    });
  });

  describe("buildLocationOptions", () => {
    it("offers any/remote, then only states with listings, sorted by name", () => {
      expect(buildLocationOptions(facets, null)).toEqual([
        { value: "", label: "Any location" },
        { value: "remote", label: "Remote" },
        { value: "CA", label: "California" },
        { value: "DC", label: "District of Columbia" },
        { value: "NY", label: "New York" },
        { value: "TX", label: "Texas" },
      ]);
    });

    it("still shows a selected state with no listings (deep link)", () => {
      const values = buildLocationOptions(facets, "ME").map((o) => o.value);
      expect(values).toEqual(["", "remote", "CA", "DC", "ME", "NY", "TX"]);
    });

    it("offers only any/remote when facets failed (plus a selected state)", () => {
      expect(buildLocationOptions(null, null).map((o) => o.value)).toEqual(["", "remote"]);
      expect(buildLocationOptions(null, "remote").map((o) => o.value)).toEqual(["", "remote"]);
      expect(buildLocationOptions(null, "WA")).toEqual([
        { value: "", label: "Any location" },
        { value: "remote", label: "Remote" },
        { value: "WA", label: "Washington" },
      ]);
    });
  });

  it("sort offers Best match and Most recent", () => {
    expect(JOBS_SORT_OPTIONS.map((o) => o.label)).toEqual(["Best match", "Most recent"]);
  });
});

describe("listActiveJobsFilters", () => {
  it("is empty with nothing applied (sort alone isn't a filter)", () => {
    expect(listActiveJobsFilters(Q())).toEqual([]);
    expect(listActiveJobsFilters(Q({ sort: "recent" }))).toEqual([]);
  });

  it("gives one chip per filter, each removing only that param", () => {
    const query = Q({
      q: "react",
      level: "Internship",
      category: "software",
      location: "remote",
      sort: "recent",
    });
    expect(listActiveJobsFilters(query)).toEqual([
      {
        key: "q",
        name: "Search",
        value: "“react”",
        // Removing the search also drops sort.
        removeHref: "/jobs?level=Internship&category=software&location=remote",
      },
      {
        key: "level",
        name: "Level",
        value: "Internship",
        removeHref: "/jobs?q=react&category=software&location=remote&sort=recent",
      },
      {
        key: "category",
        name: "Field",
        value: "Software Engineering",
        removeHref: "/jobs?q=react&level=Internship&location=remote&sort=recent",
      },
      {
        key: "location",
        name: "Location",
        value: "Remote",
        removeHref: "/jobs?q=react&level=Internship&category=software&sort=recent",
      },
    ]);
  });

  it("labels a state by name", () => {
    expect(listActiveJobsFilters(Q({ location: "DC" }))[0]).toMatchObject({
      value: "District of Columbia",
      removeHref: "/jobs",
    });
  });
});

describe("dates", () => {
  it("jobPostedAt prefers the source's posted date", () => {
    expect(jobPostedAt({ posted_at: "2026-11-01T00:00:00Z", created_at: "2026-11-02T00:00:00Z" })).toBe(
      "2026-11-01T00:00:00Z",
    );
    expect(jobPostedAt({ posted_at: null, created_at: "2026-11-02T00:00:00Z" })).toBe(
      "2026-11-02T00:00:00Z",
    );
  });

  it.each([
    [0, "today"],
    [0.9, "today"],
    [1, "yesterday"],
    [2, "2 days ago"],
    [6, "6 days ago"],
    [7, "1 week ago"],
    [13, "1 week ago"],
    [14, "2 weeks ago"],
    [29, "4 weeks ago"],
    [30, "1 month ago"],
    [65, "2 months ago"],
    [364, "12 months ago"],
    [365, "1 year ago"],
    [800, "2 years ago"],
  ])("formatRelativeDays(%s days) = %s", (days, expected) => {
    expect(formatRelativeDays(daysAgo(days), NOW)).toBe(expected);
  });

  it("treats future dates (clock skew) as today", () => {
    expect(formatRelativeDays(daysAgo(-3), NOW)).toBe("today");
  });

  it("returns null for missing or invalid input", () => {
    expect(formatRelativeDays(null, NOW)).toBeNull();
    expect(formatRelativeDays(undefined, NOW)).toBeNull();
    expect(formatRelativeDays("", NOW)).toBeNull();
    expect(formatRelativeDays("not a date", NOW)).toBeNull();
  });

  it("formatAbsoluteDate is fixed-locale UTC", () => {
    expect(formatAbsoluteDate("2026-11-18T23:30:00Z")).toBe("Nov 18, 2026");
    expect(formatAbsoluteDate("2026-01-02T00:00:00-05:00")).toBe("Jan 2, 2026");
    expect(formatAbsoluteDate("nope")).toBeNull();
    expect(formatAbsoluteDate(null)).toBeNull();
  });
});

describe("toPlainText", () => {
  it("returns empty for empty input", () => {
    expect(toPlainText(null)).toBe("");
    expect(toPlainText(undefined)).toBe("");
    expect(toPlainText("")).toBe("");
  });

  it("leaves plain text alone apart from whitespace normalisation", () => {
    expect(toPlainText("  Hello   world \r\n\r\n\r\n\r\nBye  ")).toBe("Hello world\n\nBye");
  });

  it("strips tags, keeps structure and decodes entities", () => {
    const html =
      "<p>We build <strong>tools</strong> &amp; more.</p><ul><li>Python</li><li>SQL&nbsp;skills</li></ul>Line<br/>break";
    expect(toPlainText(html)).toBe(
      "We build tools & more.\n\n- Python\n- SQL skills\nLine\nbreak",
    );
  });

  it("drops script and style contents entirely", () => {
    expect(toPlainText('Hi<script>alert("x")</script><style>p{}</style> there')).toBe(
      "Hi there",
    );
  });

  it("removes event-handler markup without leaving attributes behind", () => {
    expect(toPlainText('<img src=x onerror="alert(1)">Safe')).toBe("Safe");
  });

  it("decodes numeric entities and drops control characters", () => {
    expect(toPlainText("caf&#233; &#x2014; ok&#0;")).toBe("café — ok");
    expect(toPlainText("&rsquo;quoted&rsquo; &unknown;")).toBe("’quoted’ &unknown;");
  });

  it("keeps a literal less-than sign that isn't a tag", () => {
    expect(toPlainText("Team size < 10 people")).toBe("Team size < 10 people");
  });
});

describe("makeSnippet", () => {
  it("returns short text unchanged", () => {
    expect(makeSnippet("Short and sweet.")).toBe("Short and sweet.");
  });

  it("flattens bullets and line breaks", () => {
    expect(makeSnippet("Requirements:\n- Python\n- SQL\n\nNice to have")).toBe(
      "Requirements: Python SQL Nice to have",
    );
  });

  it("cuts at a word boundary with an ellipsis", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const snippet = makeSnippet(text, 20);
    expect(snippet).toBe("alpha beta gamma…");
    expect(snippet.length).toBeLessThanOrEqual(21);
  });

  it("hard-cuts a single very long word", () => {
    expect(makeSnippet("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("drops trailing punctuation before the ellipsis", () => {
    expect(makeSnippet("Build things, ship them. Then repeat forever", 25)).toBe(
      "Build things, ship them…",
    );
  });

  it("strips HTML", () => {
    expect(makeSnippet("<p>Hello <b>there</b></p>")).toBe("Hello there");
  });

  it("handles empty input", () => {
    expect(makeSnippet(null)).toBe("");
    expect(makeSnippet("   ")).toBe("");
  });
});

describe("toDescriptionBlocks", () => {
  it("returns no blocks for empty input", () => {
    expect(toDescriptionBlocks("")).toEqual([]);
    expect(toDescriptionBlocks(null)).toEqual([]);
  });

  it("splits paragraphs on blank lines and keeps single line breaks", () => {
    expect(toDescriptionBlocks("One\ntwo\n\nThree")).toEqual([
      { type: "paragraph", lines: ["One", "two"] },
      { type: "paragraph", lines: ["Three"] },
    ]);
  });

  it("groups bullet runs into lists, across bullet styles", () => {
    expect(toDescriptionBlocks("Intro\n- a\n* b\n• c\n1. d\n2) e\nOutro")).toEqual([
      { type: "paragraph", lines: ["Intro"] },
      { type: "list", items: ["a", "b", "c", "d", "e"] },
      { type: "paragraph", lines: ["Outro"] },
    ]);
  });

  it("detects short 'Heading:' lines, including directly above a list or text", () => {
    expect(
      toDescriptionBlocks("About us:\nWe make things.\n\nRequirements:\n- Python\n\nBenefits:"),
    ).toEqual([
      { type: "heading", text: "About us" },
      { type: "paragraph", lines: ["We make things."] },
      { type: "heading", text: "Requirements" },
      { type: "list", items: ["Python"] },
      { type: "heading", text: "Benefits" },
    ]);
  });

  it("does not treat a colon at the end of a long sentence as a heading", () => {
    const sentence =
      "In this role you will partner with engineers and designers on the following:";
    expect(toDescriptionBlocks(sentence)).toEqual([
      { type: "paragraph", lines: [sentence] },
    ]);
  });

  it("keeps a colon line inside a paragraph as text", () => {
    expect(toDescriptionBlocks("We offer:\nGreat pay")).toEqual([
      { type: "heading", text: "We offer" },
      { type: "paragraph", lines: ["Great pay"] },
    ]);
    expect(toDescriptionBlocks("Hello there\nWe offer:")).toEqual([
      { type: "paragraph", lines: ["Hello there", "We offer:"] },
    ]);
  });

  it("works on HTML input", () => {
    expect(toDescriptionBlocks("<p>Hi</p><ul><li>One</li><li>Two</li></ul>")).toEqual([
      { type: "paragraph", lines: ["Hi"] },
      { type: "list", items: ["One", "Two"] },
    ]);
  });

  it("skips empty bullets without splitting the list", () => {
    expect(toDescriptionBlocks("- a\n-  \n- b")).toEqual([
      { type: "list", items: ["a", "b"] },
    ]);
  });
});

describe("getJobSourceInfo", () => {
  it("labels community submissions", () => {
    const info = getJobSourceInfo("user");
    expect(info.label).toBe("Community");
    expect(info.kind).toBe("community");
    expect(info.attribution).toBeNull();
    expect(info.applyLabel).toBe("View original posting");
  });

  it("labels The Muse with a required link-back", () => {
    const info = getJobSourceInfo("themuse");
    expect(info.label).toBe("The Muse");
    expect(info.kind).toBe("external");
    expect(info.attribution).toEqual({ text: "The Muse", href: "https://www.themuse.com" });
    expect(info.applyLabel).toBe("Apply on The Muse");
  });

  it.each([
    ["greenhouse", "Greenhouse"],
    ["lever", "Lever"],
  ])("labels %s listings as employer postings without attribution", (source, provider) => {
    const info = getJobSourceInfo(source);
    expect(info.label).toBe("Employer posting");
    expect(info.kind).toBe("external");
    expect(info.description).toBe(`From the company's careers site (via ${provider})`);
    expect(info.attribution).toBeNull();
    expect(info.applyLabel).toBe("Apply on company site");
  });

  it("falls back for unknown sources without echoing the raw value", () => {
    const info = getJobSourceInfo("somewhere-new");
    expect(info.label).toBe("External");
    expect(info.kind).toBe("external");
    expect(info.attribution).toBeNull();
  });
});

describe("safeExternalUrl / displayHost", () => {
  it("accepts http and https", () => {
    expect(safeExternalUrl("https://www.themuse.com/jobs/acme/intern")).toBe(
      "https://www.themuse.com/jobs/acme/intern",
    );
    expect(safeExternalUrl(" http://example.com ")).toBe("http://example.com/");
  });

  it("rejects other schemes, relative and malformed URLs", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,hi")).toBeNull();
    expect(safeExternalUrl("/jobs/1")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
    expect(safeExternalUrl("")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });

  it("displayHost strips www and rejects unsafe URLs", () => {
    expect(displayHost("https://www.themuse.com/jobs/x")).toBe("themuse.com");
    expect(displayHost("https://careers.acme.dev/1")).toBe("careers.acme.dev");
    expect(displayHost("javascript:alert(1)")).toBeNull();
  });
});
