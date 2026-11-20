import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DashboardView } from "@/components/dashboard/DashboardView";
import type { CritiqueQuota, DashboardData, DashboardResume } from "@/lib/client/dashboard";
import type { RecentMatch } from "@/types/domain";

/**
 * Static-render tests of the dashboard's main states (node environment, no
 * jsdom, same approach as components/settings/UsageLimits.test.tsx).
 * Synthetic data only.
 */

const QUOTA: CritiqueQuota = { limit: 5, used: 2, remaining: 3, resetsAt: "2026-11-19T00:00:00.000Z" };

const UNCRITIQUED: DashboardResume = {
  id: "r-new",
  file_name: "Jordan_Lee_Resume_Fall.pdf",
  file_type: "application/pdf",
  created_at: "2026-11-15T12:00:00Z",
  critique: null,
};

const CRITIQUED: DashboardResume = {
  id: "r-old",
  file_name: "Jordan_Lee_Resume.docx",
  file_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  created_at: "2026-11-02T12:00:00Z",
  critique: {
    id: "c1",
    overall_score: 71,
    created_at: "2026-11-03T12:00:00Z",
    top_priority: {
      dimension: "impact",
      score: 58,
      top_fix: "Add a measurable result to each <script>experience</script> bullet.",
    },
  },
};

function match(id: string, score: number): RecentMatch {
  return {
    id,
    score,
    rationale: "Your SQL coursework and dashboard project line up with the core duties.",
    matched_strengths: [],
    gaps: [],
    created_at: "2026-11-10T12:00:00Z",
    job_description: { id: `job-${id}`, title: `Data Analyst Intern ${id}`, company: "Northwind", deleted_at: null },
    resume: { id: "r-old", file_name: "Jordan_Lee_Resume.docx" },
  };
}

function render(data: DashboardData) {
  return renderToStaticMarkup(<DashboardView data={data} />);
}

function data(items: DashboardResume[], overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    resumes: { status: "ok", data: { items, critiquesFailed: false } },
    matches: { status: "ok", data: [] },
    quota: { status: "ok", data: QUOTA },
    ...overrides,
  };
}

describe("DashboardView", () => {
  it("first run: welcome, three steps, one upload CTA, usage still shown", () => {
    const html = render(data([]));
    expect(html).toContain("Welcome to Kalify");
    expect(html).toContain("Let&#x27;s see where your resume stands");
    expect(html).toContain("Upload your resume");
    expect(html).toContain("Get a detailed critique");
    expect(html).toContain("Match it against real jobs");
    expect(html).toContain('href="/resumes"');
    expect(html).toContain("What your critique includes");
    expect(html).toContain("3 of 5 critiques left today");
    // No empty resume/match panels or next-step card for a new user.
    expect(html).not.toContain("Your next step");
    expect(html).not.toContain("Top matches");
    expect(html).not.toContain('role="alert"');
  });

  it("resume without a critique: next step is to run one, with a per-resume prompt", () => {
    const html = render(data([UNCRITIQUED]));
    expect(html).toContain("Welcome back");
    expect(html).toContain("Your next step");
    expect(html).toContain("Get a critique of Jordan_Lee_Resume_Fall.pdf");
    expect(html).toContain('href="/resumes/r-new#resume-critique-heading"');
    expect(html).toContain("No critique yet");
    expect(html).toContain("Get a critique");
    expect(html).toContain("No matches yet");
    expect(html).toContain('href="/jobs"');
  });

  it("critique present: score ring, band, and the top fix as plain text", () => {
    const html = render(data([CRITIQUED]));
    expect(html).toContain("Top fix · Impact &amp; results");
    // Model text is escaped, never injected as HTML.
    expect(html).toContain("&lt;script&gt;experience&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("71");
    expect(html).toContain("/100, Needs polish");
    expect(html).toContain("View critique");
    expect(html).toContain("DOCX");
    expect(html).toContain("Uploaded <time");
    expect(html).toContain("Match your resume against real jobs");
  });

  it("matches present: top matches with job and resume links, best match as a follow-up", () => {
    const html = render(
      data([CRITIQUED], { matches: { status: "ok", data: [match("a", 88), match("b", 64)] } }),
    );
    expect(html).toContain("Top matches");
    expect(html).toContain('href="/jobs/job-a"');
    expect(html).toContain('href="/jobs/job-b"');
    expect(html).toContain('href="/resumes/r-old"');
    expect(html).toContain("Your best match");
    expect(html).toContain("Data Analyst Intern a at Northwind");
    expect(html).toContain("Scored 88/100 against Jordan_Lee_Resume.docx.");
    expect(html).toContain('href="/matches"');
  });

  it("lists at most five resumes with a View all link", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...UNCRITIQUED, id: `r${i}`, file_name: `Resume_${i}.pdf` }));
    const html = render(data(many));
    expect(html).toContain("View all 7");
    expect(html).toContain("Resume_4.pdf");
    expect(html).not.toContain("Resume_5.pdf");
  });

  it("exhausted quota: says so in usage and in the next step", () => {
    const html = render(
      data([UNCRITIQUED], { quota: { status: "ok", data: { ...QUOTA, used: 5, remaining: 0 } } }),
    );
    expect(html).toContain("0 of 5 critiques left today");
    expect(html).toContain("You&#x27;ve used today&#x27;s critiques");
    expect(html).toContain("Open resume");
  });

  it("section errors render alerts without blanking the page", () => {
    const html = render({
      resumes: { status: "error" },
      matches: { status: "error" },
      quota: { status: "error" },
    });
    expect(html).toContain("Couldn&#x27;t load your resumes");
    expect(html).toContain("Couldn&#x27;t load your matches");
    expect(html).toContain("Couldn&#x27;t load your usage");
    expect(html).toContain("We couldn&#x27;t work out your next step");
    expect(html).not.toContain("Welcome to Kalify");
  });

  it("critique scores failing shows an alert and hides per-resume critique links", () => {
    const html = render({
      ...data([UNCRITIQUED]),
      resumes: { status: "ok", data: { items: [UNCRITIQUED], critiquesFailed: true } },
    });
    expect(html).toContain("Couldn&#x27;t load your critique scores");
    expect(html).not.toContain("resume-critique-heading");
  });

  it("states the privacy model", () => {
    expect(render(data([]))).toContain("private to your account");
  });
});
