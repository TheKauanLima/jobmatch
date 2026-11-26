import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// JobsFilterSelect (a client component) calls useRouter; static rendering
// has no App Router mounted.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { JobDescriptionCard } from "@/components/jobs/JobDescriptionCard";
import { JobDescriptionList } from "@/components/jobs/JobDescriptionList";
import { JobsBoardLayout, JobsResults } from "@/components/jobs/JobsBoard";
import {
  JobsEmptyState,
  JobsErrorState,
  JobsResultsSkeleton,
} from "@/components/jobs/JobsBoardStates";
import { JobsFilterSelect } from "@/components/jobs/JobsFilterSelect";
import { JobsSearchControls } from "@/components/jobs/JobsSearchControls";
import { JobsSearchInput } from "@/components/jobs/JobsSearchInput";
import { EMPTY_JOBS_QUERY, type JobsBoardQuery, type JobsFacets } from "@/lib/client/jobsBoard";
import type { JobDescription } from "@/types/domain";

/**
 * Static-render tests for the jobs board. The Vitest setup runs in node (no
 * jsdom), so interaction ("Load more", navigation) is covered at the helper
 * level in lib/client/jobsBoard.test.ts and the markup per state is
 * asserted here.
 */

const NOW = Date.parse("2026-11-18T12:00:00.000Z");

const Q = (overrides: Partial<JobsBoardQuery> = {}): JobsBoardQuery => ({
  ...EMPTY_JOBS_QUERY,
  ...overrides,
});

function job(overrides: Partial<JobDescription> = {}): JobDescription {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Software Engineering Intern",
    company: "Northwind Labs",
    description:
      "Join our platform team for the summer.\n\nWhat you'll do:\n- Build internal tools in TypeScript\n- Ship features with a mentor",
    source_url: "https://www.themuse.com/jobs/northwindlabs/software-engineering-intern",
    created_at: "2026-11-16T09:00:00.000Z",
    updated_at: "2026-11-16T09:00:00.000Z",
    source: "themuse",
    level: "Internship",
    location: "Austin, TX",
    posted_at: "2026-11-15T09:00:00.000Z",
    is_own: false,
    deleted_at: null,
    job_category: null,
    ...overrides,
  };
}

describe("JobDescriptionCard", () => {
  it("renders title link, company, location, badges and relative date", () => {
    const html = renderToStaticMarkup(<JobDescriptionCard jobDescription={job()} now={NOW} />);
    expect(html).toContain('href="/jobs/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain("Software Engineering Intern");
    expect(html).toContain("Northwind Labs");
    expect(html).toContain("Austin, TX");
    expect(html).toContain("Internship");
    expect(html).toContain("The Muse");
    // posted_at (3 days before NOW) wins over created_at.
    expect(html).toContain("Posted 3 days ago");
    expect(html).toContain('dateTime="2026-11-15T09:00:00.000Z"');
    expect(html).toContain('title="Nov 15, 2026"');
  });

  it("uses a heading so the list has an outline, defaulting to h3", () => {
    expect(renderToStaticMarkup(<JobDescriptionCard jobDescription={job()} now={NOW} />)).toMatch(
      /<h3[^>]*>/,
    );
    expect(
      renderToStaticMarkup(
        <JobDescriptionCard jobDescription={job()} now={NOW} headingLevel="h2" />,
      ),
    ).toMatch(/<h2[^>]*>/);
  });

  it("shows a flattened plain-text snippet, never markup", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionCard
        jobDescription={job({
          description: '<p>Hello <img src=x onerror="alert(1)"><b>world</b></p><script>alert(2)</script>',
        })}
        now={NOW}
      />,
    );
    expect(html).toContain("Hello world");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(");
  });

  it("escapes a title that looks like HTML", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionCard jobDescription={job({ title: "<b>Intern</b>" })} now={NOW} />,
    );
    expect(html).toContain("&lt;b&gt;Intern&lt;/b&gt;");
    expect(html).not.toContain("<b>Intern");
  });

  it("labels community submissions and the caller's own posting", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionCard
        jobDescription={job({ source: "user", is_own: true, posted_at: null, level: null })}
        now={NOW}
      />,
    );
    expect(html).toContain("Community");
    expect(html).toContain("Your posting");
    expect(html).not.toContain("The Muse");
    // Falls back to created_at (2 days before NOW).
    expect(html).toContain("Posted 2 days ago");
  });

  it.each([
    ["greenhouse", "Greenhouse", "https://job-boards.greenhouse.io/northwindlabs/jobs/4012345"],
    ["lever", "Lever", "https://jobs.lever.co/northwindlabs/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab"],
  ] as const)("labels %s listings as an employer posting", (source, provider, sourceUrl) => {
    const html = renderToStaticMarkup(
      <JobDescriptionCard jobDescription={job({ source, source_url: sourceUrl })} now={NOW} />,
    );
    expect(html).toContain("Employer posting");
    expect(html).toContain(`title="From the company&#x27;s careers site (via ${provider})"`);
    expect(html).not.toContain("The Muse");
    expect(html).not.toContain("Community");
  });

  it("omits optional rows when company, location and date are missing", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionCard
        jobDescription={job({ company: null, location: null, created_at: "bad", posted_at: null })}
        now={NOW}
      />,
    );
    expect(html).not.toContain("Company:");
    expect(html).not.toContain("Location:");
    expect(html).not.toContain("Posted");
  });
});

describe("JobFieldBadge on cards", () => {
  it("shows the field label as a tag", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionCard jobDescription={job({ job_category: "data" })} now={NOW} />,
    );
    expect(html).toContain("Field: </span>Data &amp; AI");
  });

  it.each([null, "other"] as const)("omits the tag for %s", (category) => {
    const html = renderToStaticMarkup(
      <JobDescriptionCard jobDescription={job({ job_category: category })} now={NOW} />,
    );
    expect(html).not.toContain("Field:");
    expect(html).not.toContain(">Other<");
  });
});

describe("JobDescriptionList", () => {
  it("populated: result count and one list item per job", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionList
        initialJobDescriptions={[
          job(),
          job({ id: "22222222-2222-4222-8222-222222222222", title: "Data Analyst" }),
        ]}
        initialNextCursor={null}
        query={Q()}
        now={NOW}
      />,
    );
    expect(html).toContain("2 jobs · Newest first");
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain("Data Analyst");
    expect(html).not.toContain("Load more");
  });

  it("more pages available: N+ count and a Load more button", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionList
        initialJobDescriptions={[job()]}
        initialNextCursor="offset_20"
        query={Q({ q: "intern", level: "Internship", location: "TX" })}
        now={NOW}
      />,
    );
    expect(html).toContain("1+ internship jobs matching");
    expect(html).toContain("intern");
    expect(html).toContain("· Texas");
    expect(html).not.toContain("Newest first");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Load more jobs<\/button>/);
  });

  it("no results for a search alone: says what was searched and offers a reset", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionList
        initialJobDescriptions={[]}
        initialNextCursor={null}
        query={Q({ q: "quantum" })}
        now={NOW}
      />,
    );
    expect(html).toContain("No jobs match “quantum”");
    expect(html).toContain('href="/jobs"');
    expect(html).toContain("Clear search");
    expect(html).not.toContain("these filters");
  });

  it("no results with filters: one removable chip per filter, then Clear all", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionList
        initialJobDescriptions={[]}
        initialNextCursor={null}
        query={Q({ q: "quantum", level: "Entry Level", category: "science", location: "remote", sort: "recent" })}
        now={NOW}
      />,
    );
    expect(html).toContain("No jobs match these filters");
    expect(html).toContain('aria-label="Active filters"');
    expect(html.match(/Remove filter /g)).toHaveLength(4);
    // Each chip drops only its own param (dropping the search also drops sort).
    expect(html).toContain('href="/jobs?level=Entry+Level&amp;category=science&amp;location=remote"');
    expect(html).toContain('href="/jobs?q=quantum&amp;category=science&amp;location=remote&amp;sort=recent"');
    expect(html).toContain('href="/jobs?q=quantum&amp;level=Entry+Level&amp;location=remote&amp;sort=recent"');
    expect(html).toContain('href="/jobs?q=quantum&amp;level=Entry+Level&amp;category=science&amp;sort=recent"');
    expect(html).toContain("Science &amp; Research");
    expect(html).toContain(">Remote<");
    expect(html).toContain('href="/jobs"');
    expect(html).toContain("Clear all");
  });

  it("empty board (no filters): explains and points at sharing a posting", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionList initialJobDescriptions={[]} initialNextCursor={null} query={Q()} />,
    );
    expect(html).toContain("No jobs on the board yet");
    expect(html).not.toContain("Clear all");
    expect(html).not.toContain("Clear search");
  });
});

describe("board states", () => {
  it("JobsResults renders the error state with a retry that keeps the query", () => {
    const html = renderToStaticMarkup(
      <JobsResults
        query={Q({ q: "design", level: "Internship", category: "design", location: "NY" })}
        firstPage={{ kind: "error" }}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("couldn&#x27;t load jobs");
    expect(html).toContain(
      'href="/jobs?q=design&amp;level=Internship&amp;category=design&amp;location=NY"',
    );
    expect(html).toContain("Try again");
  });

  it("JobsResults renders the list for a loaded page", () => {
    const html = renderToStaticMarkup(
      <JobsResults
        query={Q()}
        firstPage={{ kind: "ok", jobDescriptions: [job()], nextCursor: null }}
        now={NOW}
      />,
    );
    expect(html).toContain("1 job");
    expect(html).toContain("Software Engineering Intern");
  });

  it("JobsErrorState without a query retries /jobs", () => {
    expect(renderToStaticMarkup(<JobsErrorState query={Q()} />)).toContain('href="/jobs"');
  });

  it("JobsEmptyState for a level filter alone uses the filters copy", () => {
    const html = renderToStaticMarkup(<JobsEmptyState query={Q({ level: "Internship" })} />);
    expect(html).toContain("No jobs match these filters");
    expect(html).toContain('href="/jobs"');
    expect(html.match(/Remove filter /g)).toHaveLength(1);
  });

  it("skeleton is busy and announces loading", () => {
    const html = renderToStaticMarkup(<JobsResultsSkeleton count={2} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading jobs");
  });
});

describe("JobsBoardLayout", () => {
  it("intro names company career sites, not The Muse", () => {
    const html = renderToStaticMarkup(
      <JobsBoardLayout query={Q()} facets={null} submitForm={<p>FORM-SLOT</p>}>
        <p>RESULTS-SLOT</p>
      </JobsBoardLayout>,
    );
    expect(html).toContain("Internship and entry-level roles from company career sites");
    expect(html).not.toContain("The Muse");
    expect(html).toContain("RESULTS-SLOT");
  });
});

const FACETS: JobsFacets = {
  categories: { software: 120, data: 30 },
  states: { CA: 50, NY: 20 },
  remote: 12,
};

/** The `<select id=...>...</select>` markup for one filter. */
function selectMarkup(html: string, param: string): string {
  const match = html.match(new RegExp(`<select[^>]*id="jobs-filter-${param}"[\\s\\S]*?</select>`));
  return match?.[0] ?? "";
}

describe("JobsSearchControls", () => {
  it("labels the search box, keeps every filter in the form and marks the active pill", () => {
    const html = renderToStaticMarkup(
      <JobsSearchControls
        query={Q({ q: "react", level: "Internship", category: "software", location: "CA", sort: "recent" })}
        facets={FACETS}
      />,
    );
    expect(html).toContain('role="search"');
    expect(html).toMatch(/<label[^>]*for="job-search"/);
    expect(html).toContain('name="q"');
    expect(html).toContain('value="react"');
    expect(html).toMatch(/<input type="hidden" name="level" value="Internship"\/>/);
    expect(html).toMatch(/<input type="hidden" name="category" value="software"\/>/);
    expect(html).toMatch(/<input type="hidden" name="location" value="CA"\/>/);
    expect(html).toMatch(/<input type="hidden" name="sort" value="recent"\/>/);
    // Active pill: aria-current; the other pills keep the search and filters.
    expect(html).toMatch(
      /aria-current="true"[^>]*href="\/jobs\?q=react&amp;level=Internship&amp;category=software&amp;location=CA&amp;sort=recent"/,
    );
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).toContain('href="/jobs?q=react&amp;category=software&amp;location=CA&amp;sort=recent"');
    expect(html).toContain(
      'href="/jobs?q=react&amp;level=Entry+Level&amp;category=software&amp;location=CA&amp;sort=recent"',
    );
    expect(html).toContain("Clear all");
  });

  it("renders Field, Location and Sort as labelled native selects reflecting the URL", () => {
    const html = renderToStaticMarkup(
      <JobsSearchControls
        query={Q({ q: "react", category: "data", location: "NY", sort: "recent" })}
        facets={FACETS}
      />,
    );
    for (const [param, label] of [
      ["category", "Field"],
      ["location", "Location"],
      ["sort", "Sort"],
    ]) {
      expect(html).toMatch(new RegExp(`<label[^>]*for="jobs-filter-${param}"[^>]*>${label}</label>`));
      expect(selectMarkup(html, param)).not.toBe("");
    }
    expect(selectMarkup(html, "category")).toMatch(/<option value="data" selected="">Data &amp; AI<\/option>/);
    expect(selectMarkup(html, "location")).toMatch(/<option value="NY" selected="">New York<\/option>/);
    expect(selectMarkup(html, "sort")).toMatch(/<option value="recent" selected="">Most recent<\/option>/);
    expect(selectMarkup(html, "sort")).toContain(">Best match<");
  });

  it("disables fields with no listings and offers only states that have listings", () => {
    const html = renderToStaticMarkup(<JobsSearchControls query={Q()} facets={FACETS} />);
    const field = selectMarkup(html, "category");
    expect(field).toContain('<option value="" selected="">All fields</option>');
    expect(field).toContain('<option value="software">Software Engineering</option>');
    expect(field).toContain(
      '<option value="trades" disabled="">Skilled Trades &amp; Construction (no listings yet)</option>',
    );
    const location = selectMarkup(html, "location");
    expect(location.match(/<option /g)).toHaveLength(4);
    expect(location).toContain(">Any location<");
    expect(location).toContain('<option value="remote">Remote</option>');
    expect(location).toContain('<option value="CA">California</option>');
    expect(location).toContain('<option value="NY">New York</option>');
    expect(location).not.toContain("Texas");
  });

  it("keeps a deep-linked state with no listings selectable", () => {
    const html = renderToStaticMarkup(
      <JobsSearchControls query={Q({ location: "ME" })} facets={FACETS} />,
    );
    expect(selectMarkup(html, "location")).toMatch(/<option value="ME" selected="">Maine<\/option>/);
  });

  it("facets failed: every field enabled, location offers only Any location and Remote", () => {
    const html = renderToStaticMarkup(<JobsSearchControls query={Q()} facets={null} />);
    const field = selectMarkup(html, "category");
    expect(field).not.toContain("disabled");
    expect(field).not.toContain("no listings yet");
    expect(field.match(/<option /g)).toHaveLength(16);
    const location = selectMarkup(html, "location");
    expect(location.match(/<option /g)).toHaveLength(2);
    expect(location).toContain(">Any location<");
    expect(location).toContain(">Remote<");
  });

  it("no search: no sort control, 'All levels' is active and there's nothing to clear", () => {
    const html = renderToStaticMarkup(<JobsSearchControls query={Q()} facets={FACETS} />);
    expect(selectMarkup(html, "sort")).toBe("");
    expect(html).not.toContain(">Sort<");
    expect(html).toMatch(/aria-current="true"[^>]*href="\/jobs"/);
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).not.toContain("Clear all");
    expect(html).not.toContain('type="hidden"');
  });

  it("a filter alone shows Clear all", () => {
    const html = renderToStaticMarkup(
      <JobsSearchControls query={Q({ location: "remote" })} facets={FACETS} />,
    );
    expect(html).toContain("Clear all");
    expect(html).toMatch(/<input type="hidden" name="location" value="remote"\/>/);
  });
});

/**
 * Focus survives a URL change (WCAG 2.4.3 / 3.2.2). There's no DOM in this
 * Vitest setup (no jsdom), so `document.activeElement` can't be checked.
 * Instead this asserts the precondition React needs to keep the same DOM
 * node: the select and the search input sit at the same position in the tree,
 * with the same type and key, for different queries. Next 16 keys the page
 * segment without search params (layout-router `createRouterCacheKey(…, true)`),
 * so the page itself isn't remounted on a filter change either.
 */
type Found = { path: string; key: string | null; name: string };

function collect(node: ReactNode, wanted: Set<unknown>, path = "root", out: Found[] = []): Found[] {
  if (Array.isArray(node)) {
    node.forEach((child, i) => collect(child, wanted, `${path}[${i}]`, out));
    return out;
  }
  if (!isValidElement(node)) return out;
  const element = node as ReactElement<{ children?: ReactNode }>;
  const typeName =
    typeof element.type === "string" ? element.type : (element.type as { name?: string }).name ?? "?";
  const here = `${path}>${typeName}${element.key !== null ? `#${element.key}` : ""}`;
  if (wanted.has(element.type)) {
    out.push({ path: here, key: element.key, name: typeName });
  }
  collect(element.props.children, wanted, here, out);
  return out;
}

describe("JobsSearchControls keeps controls mounted across URL changes", () => {
  const wanted = new Set<unknown>([JobsFilterSelect, JobsSearchInput]);
  const tree = (query: JobsBoardQuery) =>
    collect(JobsSearchControls({ query, facets: FACETS }), wanted);

  it("Field, Location and the search box keep their position and key when filters change", () => {
    const before = tree(Q());
    const after = tree(Q({ category: "data", location: "CA", level: "Internship" }));
    expect(before.map((f) => f.name)).toEqual(["JobsSearchInput", "JobsFilterSelect", "JobsFilterSelect"]);
    expect(after).toEqual(before);
  });

  it("changing the search term or sort doesn't remount anything", () => {
    const before = tree(Q({ q: "react", category: "software" }));
    const after = tree(Q({ q: "rust", category: "software", sort: "recent" }));
    expect(before).toHaveLength(4); // search + Field + Location + Sort
    expect(after).toEqual(before);
  });

  it("uses stable per-filter keys, and no key on the search box", () => {
    const found = tree(Q({ q: "go", location: "remote" }));
    expect(found.map((f) => f.key)).toEqual([null, "category", "location", "sort"]);
  });
});

describe("JobsSearchInput", () => {
  it("is controlled and shows the URL's search term", () => {
    const html = renderToStaticMarkup(<JobsSearchInput q="data analyst" />);
    expect(html).toContain('value="data analyst"');
    expect(html).toContain('name="q"');
    expect(html).toContain('id="job-search"');
    expect(renderToStaticMarkup(<JobsSearchInput q={null} />)).toContain('value=""');
  });
});

describe("JobsFilterSelect", () => {
  it("renders the URL value as the controlled value", () => {
    const options = [
      { value: "", label: "Any location" },
      { value: "remote", label: "Remote" },
    ];
    const any = renderToStaticMarkup(
      <JobsFilterSelect param="location" label="Location" value="" options={options} query={Q()} />,
    );
    expect(any).toContain('<option value="" selected="">Any location</option>');
    const remote = renderToStaticMarkup(
      <JobsFilterSelect
        param="location"
        label="Location"
        value="remote"
        options={options}
        query={Q({ location: "remote" })}
      />,
    );
    expect(remote).toContain('<option value="remote" selected="">Remote</option>');
  });
});
