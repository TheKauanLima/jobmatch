import { describe, expect, it } from "vitest";

import {
  buildJobsApiPath,
  buildJobsHref,
  displayHost,
  formatAbsoluteDate,
  formatRelativeDays,
  formatResultSummary,
  getJobSourceInfo,
  isJobLevelFilter,
  JOB_LEVEL_FILTERS,
  jobPostedAt,
  jobsQueryKey,
  JOBS_SEARCH_MAX_LENGTH,
  makeSnippet,
  parseJobsSearchParams,
  safeExternalUrl,
  toDescriptionBlocks,
  toPlainText,
} from "@/lib/client/jobsBoard";
import { JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH } from "@/lib/supabase/queries/jobDescriptions";
import { JOB_DESCRIPTION_LEVELS } from "@/lib/validation/schemas";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

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

  describe("parseJobsSearchParams", () => {
    it("returns empty state for no params", () => {
      expect(parseJobsSearchParams({})).toEqual({ q: null, level: null });
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

    it("uses the first value of repeated params", () => {
      expect(
        parseJobsSearchParams({ q: ["first", "second"], level: ["Internship", "CEO"] }),
      ).toEqual({ q: "first", level: "Internship" });
    });
  });

  describe("buildJobsHref", () => {
    it("drops empty values", () => {
      expect(buildJobsHref()).toBe("/jobs");
      expect(buildJobsHref({ q: null, level: null })).toBe("/jobs");
      expect(buildJobsHref({ q: "   " })).toBe("/jobs");
    });

    it("encodes search and level", () => {
      expect(buildJobsHref({ q: "data & ml", level: "Entry Level" })).toBe(
        "/jobs?q=data+%26+ml&level=Entry+Level",
      );
      expect(buildJobsHref({ level: "Internship" })).toBe("/jobs?level=Internship");
    });

    it("round-trips through parseJobsSearchParams", () => {
      const state = { q: "product designer", level: "Internship" as const };
      const href = buildJobsHref(state);
      const params = Object.fromEntries(new URL(href, "https://x.test").searchParams);
      expect(parseJobsSearchParams(params)).toEqual(state);
    });
  });

  it("jobsQueryKey distinguishes every query combination", () => {
    const keys = new Set([
      jobsQueryKey({ q: null, level: null }),
      jobsQueryKey({ q: "a", level: null }),
      jobsQueryKey({ q: null, level: "Internship" }),
      jobsQueryKey({ q: "a", level: "Internship" }),
    ]);
    expect(keys.size).toBe(4);
  });

  it("buildJobsApiPath passes q, level and cursor through", () => {
    expect(buildJobsApiPath({ q: null, level: null })).toBe("/api/job-descriptions");
    expect(buildJobsApiPath({ q: "go", level: "Internship" }, "offset_20")).toBe(
      "/api/job-descriptions?q=go&level=Internship&cursor=offset_20",
    );
  });
});

describe("formatResultSummary", () => {
  it("shows an exact count on the last page", () => {
    expect(formatResultSummary({ count: 1, hasMore: false, q: null, level: null })).toBe(
      "1 job",
    );
    expect(formatResultSummary({ count: 7, hasMore: false, q: null, level: null })).toBe(
      "7 jobs",
    );
  });

  it("shows N+ when more pages exist (no total from the API)", () => {
    expect(formatResultSummary({ count: 20, hasMore: true, q: null, level: null })).toBe(
      "20+ jobs",
    );
  });

  it("mentions the level and search term", () => {
    expect(
      formatResultSummary({ count: 3, hasMore: false, q: "react", level: "Internship" }),
    ).toBe("3 internship jobs matching “react”");
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
