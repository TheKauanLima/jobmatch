import { describe, expect, it } from "vitest";

import {
  buildResumeOverview,
  critiqueQuotaFrom,
  deriveNextSteps,
  jobHref,
  nextStepContent,
  pickTopMatches,
  quotaHeadline,
  resumeCritiqueHref,
  type CritiqueQuota,
  type DashboardData,
  type DashboardResume,
} from "@/lib/client/dashboard";
import type { CritiqueDimension, RecentMatch, ResumeListItem } from "@/types/domain";

/** lib/client/dashboard.ts: the dashboard's pure model (synthetic data only). */

function resumeItem(id: string, created_at: string, file_name = `${id}.pdf`): ResumeListItem {
  return {
    id,
    file_name,
    file_type: "application/pdf",
    file_size_bytes: 1000,
    status: "uploaded",
    created_at,
  };
}

const DIMENSIONS: CritiqueDimension[] = [
  { dimension: "impact", score: 58, rationale: "r", top_fix: "Add a result to each bullet." },
  { dimension: "clarity", score: 80, rationale: "r", top_fix: "Shorten bullets." },
  { dimension: "relevance", score: 72, rationale: "r", top_fix: "Lead with the data project." },
  { dimension: "structure", score: 85, rationale: "r", top_fix: "Fine." },
  { dimension: "ats_readability", score: 58, rationale: "r", top_fix: "Use standard headings." },
];

function match(id: string, score: number, created_at: string): RecentMatch {
  return {
    id,
    score,
    rationale: "Strong overlap in SQL and dashboards.",
    matched_strengths: [],
    gaps: [],
    created_at,
    job_description: { id: `job-${id}`, title: `Role ${id}`, company: "Acme", deleted_at: null },
    resume: { id: "r1", file_name: "r1.pdf" },
  };
}

function dashboardResume(id: string, critique: DashboardResume["critique"]): DashboardResume {
  return { id, file_name: `${id}.pdf`, file_type: "application/pdf", created_at: "2026-11-10T00:00:00Z", critique };
}

const QUOTA: CritiqueQuota = { limit: 5, used: 2, remaining: 3, resetsAt: "2026-11-19T00:00:00.000Z" };

function data(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    resumes: { status: "ok", data: { items: [], critiquesFailed: false } },
    matches: { status: "ok", data: [] },
    quota: { status: "ok", data: QUOTA },
    ...overrides,
  };
}

const CRITIQUED = dashboardResume("r1", {
  id: "c1",
  overall_score: 71,
  created_at: "2026-11-11T00:00:00Z",
  top_priority: { dimension: "impact", score: 58, top_fix: "Add a result to each bullet." },
});

describe("buildResumeOverview", () => {
  it("keeps resume order and attaches each resume's newest critique with its top priority", () => {
    const resumes = [resumeItem("r2", "2026-11-12T00:00:00Z"), resumeItem("r1", "2026-11-01T00:00:00Z")];
    const overview = buildResumeOverview(resumes, [
      { id: "old", resume_id: "r1", overall_score: 40, created_at: "2026-11-02T00:00:00Z", dimension_scores: [] },
      { id: "new", resume_id: "r1", overall_score: 71, created_at: "2026-11-05T00:00:00Z", dimension_scores: DIMENSIONS },
    ]);
    expect(overview.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(overview[0].critique).toBeNull();
    expect(overview[1].critique).toEqual({
      id: "new",
      overall_score: 71,
      created_at: "2026-11-05T00:00:00Z",
      // Lowest score; the impact/ats tie goes to the fixed dimension order.
      top_priority: { dimension: "impact", score: 58, top_fix: "Add a result to each bullet." },
    });
  });

  it("ignores critique rows for resumes not in the list", () => {
    const overview = buildResumeOverview(
      [resumeItem("r1", "2026-11-01T00:00:00Z")],
      [{ id: "x", resume_id: "someone-else", overall_score: 90, created_at: "2026-11-02T00:00:00Z", dimension_scores: DIMENSIONS }],
    );
    expect(overview[0].critique).toBeNull();
  });

  it("tolerates malformed dimension_scores (null top priority)", () => {
    const overview = buildResumeOverview(
      [resumeItem("r1", "2026-11-01T00:00:00Z")],
      [{ id: "c", resume_id: "r1", overall_score: 60, created_at: "2026-11-02T00:00:00Z", dimension_scores: null }],
    );
    expect(overview[0].critique?.top_priority).toBeNull();
  });

  it("exposes only display fields (no storage path or resume text)", () => {
    const row = { ...resumeItem("r1", "2026-11-01T00:00:00Z"), storage_path: "u/r1.pdf", extracted_text: "secret" };
    const [item] = buildResumeOverview([row], []);
    expect(Object.keys(item).sort()).toEqual(["created_at", "critique", "file_name", "file_type", "id"]);
  });
});

describe("pickTopMatches", () => {
  it("sorts by score, newest first on ties, and trims to the count", () => {
    const matches = [
      match("a", 60, "2026-11-01T00:00:00Z"),
      match("b", 88, "2026-11-02T00:00:00Z"),
      match("c", 70, "2026-11-03T00:00:00Z"),
      match("d", 88, "2026-11-04T00:00:00Z"),
    ];
    expect(pickTopMatches(matches).map((m) => m.id)).toEqual(["d", "b", "c"]);
    expect(pickTopMatches(matches, 1).map((m) => m.id)).toEqual(["d"]);
    expect(pickTopMatches(matches, -1)).toEqual([]);
    expect(matches.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("critiqueQuotaFrom / quotaHeadline", () => {
  const row = (kind: string, daily_limit: number, used_today: number) => ({
    kind,
    daily_limit,
    used_today,
    resets_at: "2026-11-19T00:00:00.000Z",
  });

  it("reads the resume_report row", () => {
    expect(critiqueQuotaFrom([row("fit_check", 10, 1), row("resume_report", 5, 2)])).toEqual(QUOTA);
  });

  it("never reports a negative remainder", () => {
    expect(critiqueQuotaFrom([row("resume_report", 5, 7)])?.remaining).toBe(0);
  });

  it("returns null without a resume_report row", () => {
    expect(critiqueQuotaFrom([row("fit_check", 10, 1)])).toBeNull();
  });

  it("formats the headline, singular for a limit of 1", () => {
    expect(quotaHeadline(QUOTA)).toBe("3 of 5 critiques left today");
    expect(quotaHeadline({ ...QUOTA, limit: 1, used: 0, remaining: 1 })).toBe("1 of 1 critique left today");
  });
});

describe("deriveNextSteps", () => {
  it("unavailable when resumes failed to load", () => {
    expect(deriveNextSteps(data({ resumes: { status: "error" } }))).toEqual({
      primary: { kind: "unavailable" },
      followUps: [],
    });
  });

  it("upload for a first-run user", () => {
    expect(deriveNextSteps(data())).toEqual({ primary: { kind: "upload" }, followUps: [] });
  });

  it("run_critique on the newest resume when it has no critique", () => {
    const steps = deriveNextSteps(
      data({
        resumes: {
          status: "ok",
          data: { items: [dashboardResume("r2", null), CRITIQUED], critiquesFailed: false },
        },
      }),
    );
    expect(steps).toEqual({
      primary: { kind: "run_critique", resume: { id: "r2", file_name: "r2.pdf" }, quotaExhausted: false },
      followUps: [],
    });
  });

  it("flags an exhausted quota on run_critique and surfaces an existing match", () => {
    const best = match("m", 90, "2026-11-12T00:00:00Z");
    const steps = deriveNextSteps(
      data({
        resumes: { status: "ok", data: { items: [dashboardResume("r2", null)], critiquesFailed: false } },
        matches: { status: "ok", data: [match("low", 40, "2026-11-13T00:00:00Z"), best] },
        quota: { status: "ok", data: { ...QUOTA, used: 5, remaining: 0 } },
      }),
    );
    expect(steps.primary).toMatchObject({ kind: "run_critique", quotaExhausted: true });
    expect(steps.followUps).toEqual([{ kind: "view_matches", match: best }]);
  });

  it("does not claim the quota is exhausted when it failed to load", () => {
    const steps = deriveNextSteps(
      data({
        resumes: { status: "ok", data: { items: [dashboardResume("r2", null)], critiquesFailed: false } },
        quota: { status: "error" },
      }),
    );
    expect(steps.primary).toMatchObject({ kind: "run_critique", quotaExhausted: false });
  });

  it("fix_priority from the newest resume's critique, then find_matches", () => {
    const steps = deriveNextSteps(
      data({ resumes: { status: "ok", data: { items: [CRITIQUED], critiquesFailed: false } } }),
    );
    expect(steps).toEqual({
      primary: {
        kind: "fix_priority",
        resume: { id: "r1", file_name: "r1.pdf" },
        score: 71,
        priority: { dimension: "impact", score: 58, top_fix: "Add a result to each bullet." },
      },
      followUps: [{ kind: "find_matches" }],
    });
  });

  it("fix_priority then the best match when matches exist", () => {
    const best = match("m", 90, "2026-11-12T00:00:00Z");
    const steps = deriveNextSteps(
      data({
        resumes: { status: "ok", data: { items: [CRITIQUED], critiquesFailed: false } },
        matches: { status: "ok", data: [match("x", 50, "2026-11-13T00:00:00Z"), best] },
      }),
    );
    expect(steps.primary.kind).toBe("fix_priority");
    expect(steps.followUps).toEqual([{ kind: "view_matches", match: best }]);
  });

  it("no match follow-up when matches failed to load", () => {
    const steps = deriveNextSteps(
      data({
        resumes: { status: "ok", data: { items: [CRITIQUED], critiquesFailed: false } },
        matches: { status: "error" },
      }),
    );
    expect(steps.followUps).toEqual([]);
  });

  it("when critique scores failed, leads with matches instead of guessing", () => {
    const failed = { status: "ok" as const, data: { items: [dashboardResume("r1", null)], critiquesFailed: true } };
    const best = match("m", 90, "2026-11-12T00:00:00Z");
    expect(deriveNextSteps(data({ resumes: failed, matches: { status: "ok", data: [best] } }))).toEqual({
      primary: { kind: "view_matches", match: best },
      followUps: [],
    });
    expect(deriveNextSteps(data({ resumes: failed })).primary).toEqual({ kind: "find_matches" });
    expect(deriveNextSteps(data({ resumes: failed, matches: { status: "error" } })).primary).toEqual({
      kind: "unavailable",
    });
  });
});

describe("nextStepContent", () => {
  const resume = { id: "r 1", file_name: "Resume.pdf" };

  it("upload links to the resumes page", () => {
    const content = nextStepContent({ kind: "upload" });
    expect(content.title).toBe("Upload your resume");
    expect(content.cta).toEqual({ label: "Upload a resume", href: "/resumes" });
  });

  it("run_critique links to the critique card; exhausted copy mentions the reset", () => {
    const ready = nextStepContent({ kind: "run_critique", resume, quotaExhausted: false });
    expect(ready.title).toBe("Get a critique of Resume.pdf");
    expect(ready.cta).toEqual({ label: "Get a critique", href: "/resumes/r%201#resume-critique-heading" });
    const exhausted = nextStepContent({ kind: "run_critique", resume, quotaExhausted: true });
    expect(exhausted.body).toContain("00:00 UTC");
    expect(exhausted.cta?.label).toBe("Open resume");
  });

  it("fix_priority shows the fix verbatim with its dimension label", () => {
    const content = nextStepContent({
      kind: "fix_priority",
      resume,
      score: 71,
      priority: { dimension: "ats_readability", score: 58, top_fix: "<b>Use</b> standard headings." },
    });
    expect(content.eyebrow).toBe("Top fix · ATS readability");
    expect(content.title).toBe("<b>Use</b> standard headings.");
    expect(content.body).toContain("71/100");
    expect(content.cta?.href).toBe(resumeCritiqueHref("r 1"));
  });

  it("fix_priority without a priority falls back to reviewing the critique", () => {
    const content = nextStepContent({ kind: "fix_priority", resume, score: 60, priority: null });
    expect(content.title).toBe("Review the critique of Resume.pdf");
    expect(content.cta?.label).toBe("Open critique");
  });

  it("view_matches names the job and links to its page", () => {
    const content = nextStepContent({ kind: "view_matches", match: match("m", 88, "2026-11-12T00:00:00Z") });
    expect(content.title).toBe("Role m at Acme");
    expect(content.body).toBe("Scored 88/100 against r1.pdf.");
    expect(content.cta).toEqual({ label: "View job", href: jobHref("job-m") });
    const noCompany = match("n", 50, "2026-11-12T00:00:00Z");
    noCompany.job_description.company = null;
    expect(nextStepContent({ kind: "view_matches", match: noCompany }).title).toBe("Role n");
  });

  it("find_matches and unavailable", () => {
    expect(nextStepContent({ kind: "find_matches" }).cta?.href).toBe("/jobs");
    expect(nextStepContent({ kind: "unavailable" }).cta).toBeNull();
  });
});
