import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  JobDescriptionBody,
  JobDetailErrorState,
  JobDetailView,
  JobKeyFacts,
} from "@/components/jobs/JobDetail";
import type { JobDescription } from "@/types/domain";

/**
 * Static-render tests for `/jobs/[id]`'s presentational pieces. The
 * interactive slots (MatchFromJobForm, owner edit/remove) need the App
 * Router, so plain placeholders stand in for them here.
 */

const NOW = Date.parse("2026-11-18T12:00:00.000Z");

function job(overrides: Partial<JobDescription> = {}): JobDescription {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    title: "Junior Data Analyst",
    company: "Fabrikam Health",
    description:
      "Help clinicians understand their data.\n\nResponsibilities:\n- Build dashboards\n- Clean datasets\n\nWe value curiosity.",
    source_url: "https://www.themuse.com/jobs/fabrikam/junior-data-analyst",
    created_at: "2026-11-10T00:00:00.000Z",
    updated_at: "2026-11-10T00:00:00.000Z",
    source: "themuse",
    level: "Entry Level",
    location: "Remote",
    posted_at: "2026-11-04T00:00:00.000Z",
    is_own: false,
    deleted_at: null,
    ...overrides,
  };
}

describe("JobKeyFacts", () => {
  it("shows facts, attribution link-back and an external apply link", () => {
    const html = renderToStaticMarkup(<JobKeyFacts job={job()} canMatch={false} now={NOW} />);
    expect(html).toContain("Nov 4, 2026");
    expect(html).toContain("2 weeks ago");
    expect(html).toContain("Entry Level");
    expect(html).toContain("Remote");
    expect(html).toContain("Fabrikam Health");
    // The Muse attribution (link back to The Muse).
    expect(html).toMatch(
      /<a href="https:\/\/www\.themuse\.com"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/,
    );
    // Apply link to source_url, new tab, safe rel, announced as external.
    expect(html).toMatch(
      /<a href="https:\/\/www\.themuse\.com\/jobs\/fabrikam\/junior-data-analyst" target="_blank" rel="noopener noreferrer"/,
    );
    expect(html).toContain("Apply on The Muse");
    expect(html).toContain("(opens in a new tab)");
    expect(html).toContain("Opens themuse.com in a new tab");
    expect(html).not.toContain("Check my fit");
  });

  it("adds the match CTA when the caller has an analyzed resume", () => {
    const html = renderToStaticMarkup(<JobKeyFacts job={job()} canMatch now={NOW} />);
    expect(html).toContain('href="#match"');
    expect(html).toContain("Check my fit");
  });

  it("hides the match CTA for a removed posting", () => {
    const html = renderToStaticMarkup(
      <JobKeyFacts job={job({ deleted_at: "2026-11-17T00:00:00Z" })} canMatch now={NOW} />,
    );
    expect(html).not.toContain("Check my fit");
  });

  it("community posting: no attribution, 'View original posting', unspecified facts", () => {
    const html = renderToStaticMarkup(
      <JobKeyFacts
        job={job({
          source: "user",
          level: null,
          location: null,
          source_url: "https://careers.example.org/roles/42",
        })}
        canMatch={false}
        now={NOW}
      />,
    );
    expect(html).toContain("Community");
    expect(html).toContain("Shared by a Kalify user");
    expect(html).toContain("View original posting");
    expect(html).toContain("Opens careers.example.org in a new tab");
    expect(html).toContain("Not specified");
    expect(html).not.toContain('href="https://www.themuse.com"');
  });

  it("never turns an unsafe source_url into a link", () => {
    const html = renderToStaticMarkup(
      <JobKeyFacts
        job={job({ source: "user", source_url: "javascript:alert(1)" })}
        canMatch={false}
        now={NOW}
      />,
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("View original posting");
  });

  it("omits the actions block when there is nothing to do", () => {
    const html = renderToStaticMarkup(
      <JobKeyFacts job={job({ source_url: null })} canMatch={false} now={NOW} />,
    );
    expect(html).not.toContain("Apply on The Muse");
    expect(html).not.toContain("https://www.themuse.com/jobs/");
    expect(html).not.toContain("Opens themuse.com");
  });
});

describe("JobDescriptionBody", () => {
  it("renders headings, paragraphs and lists as text", () => {
    const html = renderToStaticMarkup(<JobDescriptionBody description={job().description} />);
    expect(html).toContain("About the role");
    expect(html).toMatch(/<h3[^>]*>Responsibilities<\/h3>/);
    expect(html).toMatch(/<ul[^>]*><li>Build dashboards<\/li><li>Clean datasets<\/li><\/ul>/);
    expect(html).toContain("We value curiosity.");
  });

  it("never renders markup from the description", () => {
    const html = renderToStaticMarkup(
      <JobDescriptionBody description={'<p>Hi</p><img src=x onerror="alert(1)"><script>steal()</script>'} />,
    );
    expect(html).toContain("Hi");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("steal()");
  });

  it("escapes angle brackets that survive as text", () => {
    const html = renderToStaticMarkup(<JobDescriptionBody description="Team size < 10 & growing" />);
    expect(html).toContain("Team size &lt; 10 &amp; growing");
  });

  it("empty description", () => {
    expect(renderToStaticMarkup(<JobDescriptionBody description="   " />)).toContain(
      "No description provided.",
    );
  });
});

describe("JobDetailView", () => {
  it("lays out header, facts, description and the match section", () => {
    const html = renderToStaticMarkup(
      <JobDetailView job={job()} canMatch matchSection={<p>MATCH-SLOT</p>} now={NOW} />,
    );
    expect(html).toMatch(/<h1[^>]*>Junior Data Analyst<\/h1>/);
    expect(html).toContain('href="/jobs"');
    expect(html).toContain('aria-label="Job summary"');
    expect(html).toContain('id="match"');
    expect(html).toContain("Check your fit");
    expect(html).toContain("stay private");
    expect(html).toContain("MATCH-SLOT");
    expect(html).not.toContain("Manage your posting");
  });

  it("removed posting: notice, no match section", () => {
    const html = renderToStaticMarkup(
      <JobDetailView
        job={job({ deleted_at: "2026-11-17T00:00:00Z", is_own: true, source: "user" })}
        canMatch
        matchSection={null}
        ownerTools={<p>OWNER-SLOT</p>}
        now={NOW}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("You removed this posting.");
    expect(html).not.toContain('id="match"');
    expect(html).toContain("Your posting");
    expect(html).toContain("Manage your posting");
    expect(html).toContain("OWNER-SLOT");
  });

  it("removed posting seen by someone else", () => {
    const html = renderToStaticMarkup(
      <JobDetailView
        job={job({ deleted_at: "2026-11-17T00:00:00Z" })}
        canMatch={false}
        matchSection={null}
        now={NOW}
      />,
    );
    expect(html).toContain("This posting has been removed");
  });

  it("error state: alert with a retry link to the same job", () => {
    const html = renderToStaticMarkup(<JobDetailErrorState id="abc 123" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="/jobs/abc%20123"');
    expect(html).toContain("Try again");
  });
});
