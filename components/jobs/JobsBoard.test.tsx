import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { JobDescriptionCard } from "@/components/jobs/JobDescriptionCard";
import { JobDescriptionList } from "@/components/jobs/JobDescriptionList";
import { JobsResults } from "@/components/jobs/JobsBoard";
import {
  JobsEmptyState,
  JobsErrorState,
  JobsResultsSkeleton,
} from "@/components/jobs/JobsBoardStates";
import { JobsSearchControls } from "@/components/jobs/JobsSearchControls";
import type { JobDescription } from "@/types/domain";

/**
 * Static-render tests for the jobs board. The Vitest setup runs in node (no
 * jsdom), so interaction ("Load more", navigation) is covered at the helper
 * level in lib/client/jobsBoard.test.ts and the markup per state is
 * asserted here.
 */

const NOW = Date.parse("2026-11-18T12:00:00.000Z");

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

describe("JobDescriptionList", () => {
  it("populated: result count and one list item per job", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionList
        initialJobDescriptions={[
          job(),
          job({ id: "22222222-2222-4222-8222-222222222222", title: "Data Analyst" }),
        ]}
        initialNextCursor={null}
        q={null}
        level={null}
        now={NOW}
      />,
    );
    expect(html).toContain("2 jobs");
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain("Data Analyst");
    expect(html).not.toContain("Load more");
  });

  it("more pages available: N+ count and a Load more button", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionList
        initialJobDescriptions={[job()]}
        initialNextCursor="offset_20"
        q="intern"
        level="Internship"
        now={NOW}
      />,
    );
    expect(html).toContain("1+ internship jobs matching");
    expect(html).toContain("intern");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Load more jobs<\/button>/);
  });

  it("no results for a search: says what was searched and offers resets", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionList
        initialJobDescriptions={[]}
        initialNextCursor={null}
        q="quantum"
        level="Entry Level"
        now={NOW}
      />,
    );
    expect(html).toContain("No jobs match");
    expect(html).toContain("quantum");
    expect(html).toContain("in Entry Level");
    expect(html).toContain('href="/jobs?q=quantum"');
    expect(html).toContain("Search all levels");
    expect(html).toContain('href="/jobs"');
    expect(html).toContain("Clear search and filters");
  });

  it("empty board (no filters): explains and points at sharing a posting", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionList
        initialJobDescriptions={[]}
        initialNextCursor={null}
        q={null}
        level={null}
      />,
    );
    expect(html).toContain("No jobs on the board yet");
    expect(html).not.toContain("Clear search and filters");
  });
});

describe("board states", () => {
  it("JobsResults renders the error state with a retry that keeps the query", () => {
    const html = renderToStaticMarkup(
      <JobsResults query={{ q: "design", level: "Internship" }} firstPage={{ kind: "error" }} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("couldn&#x27;t load jobs");
    expect(html).toContain('href="/jobs?q=design&amp;level=Internship"');
    expect(html).toContain("Try again");
  });

  it("JobsResults renders the list for a loaded page", () => {
    const html = renderToStaticMarkup(
      <JobsResults
        query={{ q: null, level: null }}
        firstPage={{ kind: "ok", jobDescriptions: [job()], nextCursor: null }}
        now={NOW}
      />,
    );
    expect(html).toContain("1 job");
    expect(html).toContain("Software Engineering Intern");
  });

  it("JobsErrorState without a query retries /jobs", () => {
    expect(renderToStaticMarkup(<JobsErrorState query={{ q: null, level: null }} />)).toContain(
      'href="/jobs"',
    );
  });

  it("JobsEmptyState for a level filter alone", () => {
    const html = renderToStaticMarkup(<JobsEmptyState query={{ q: null, level: "Internship" }} />);
    expect(html).toContain("No jobs match this filter");
    expect(html).not.toContain("Search all levels");
  });

  it("skeleton is busy and announces loading", () => {
    const html = renderToStaticMarkup(<JobsResultsSkeleton count={2} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading jobs");
  });
});

describe("JobsSearchControls", () => {
  it("labels the search box, keeps the level in the form and marks the active pill", () => {
    const html = renderToStaticMarkup(
      <JobsSearchControls query={{ q: "react", level: "Internship" }} />,
    );
    expect(html).toContain('role="search"');
    expect(html).toMatch(/<label[^>]*for="job-search"/);
    expect(html).toContain('name="q"');
    expect(html).toContain('value="react"');
    expect(html).toMatch(/<input type="hidden" name="level" value="Internship"\/>/);
    // Active pill: aria-current; the other pills keep the search term.
    expect(html).toMatch(/aria-current="true"[^>]*href="\/jobs\?q=react&amp;level=Internship"/);
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).toContain('href="/jobs?q=react"');
    expect(html).toContain('href="/jobs?q=react&amp;level=Entry+Level"');
    expect(html).toContain("Clear all");
  });

  it("no query: 'All levels' is active and there's nothing to clear", () => {
    const html = renderToStaticMarkup(<JobsSearchControls query={{ q: null, level: null }} />);
    expect(html).toMatch(/aria-current="true"[^>]*href="\/jobs"/);
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).not.toContain("Clear all");
    expect(html).not.toContain('type="hidden"');
  });
});
