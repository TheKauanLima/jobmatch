import {
  deriveCritiquePriorities,
  type CritiqueDimension,
  type CritiquePriority,
  type RecentMatch,
  type ResumeListItem,
} from "@/types/domain";
import { dimensionLabel } from "@/lib/client/critique";

/**
 * React-free model for the signed-in dashboard (`app/dashboard/page.tsx`,
 * `components/dashboard/*`): the per-section data shapes, the resume +
 * critique overview, top-match selection, the daily critique quota, and the
 * "next best step" derivation with its copy. Pure, so every state is
 * unit-testable without a database.
 *
 * Nothing here logs. Model text (a priority's `top_fix`, a match rationale)
 * is passed through as plain strings for React to render as text.
 */

// ---------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------

/** One dashboard section's load result: a failure in one section never blanks the others. */
export type Section<T> = { status: "ok"; data: T } | { status: "error" };

/** The latest critique of one resume, reduced to what the dashboard shows. */
export interface ResumeCritiqueSummary {
  id: string;
  overall_score: number;
  created_at: string;
  /** The lowest-scoring dimension's fix (§13.20.1 decision 6), or null if the row has no dimensions. */
  top_priority: CritiquePriority | null;
}

export interface DashboardResume {
  id: string;
  file_name: string;
  file_type: string;
  created_at: string;
  critique: ResumeCritiqueSummary | null;
}

export interface DashboardResumes {
  /** Newest first, every resume the caller owns. */
  items: DashboardResume[];
  /** The critique summaries failed to load: scores are unknown, not absent. */
  critiquesFailed: boolean;
}

export interface CritiqueQuota {
  limit: number;
  used: number;
  remaining: number;
  /** ISO timestamp of the next UTC midnight. */
  resetsAt: string;
}

export interface DashboardData {
  resumes: Section<DashboardResumes>;
  /** Top matches by score (already selected with `pickTopMatches`). */
  matches: Section<RecentMatch[]>;
  /** `null` data when no `resume_report` limit is configured. */
  quota: Section<CritiqueQuota | null>;
}

/** The summary columns read by `listLatestCritiqueSummaries`. */
export interface CritiqueSummaryInput {
  id: string;
  resume_id: string;
  overall_score: number;
  created_at: string;
  dimension_scores: unknown;
}

// ---------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------

function toCritiqueSummary(row: CritiqueSummaryInput): ResumeCritiqueSummary {
  const dimensions = Array.isArray(row.dimension_scores)
    ? (row.dimension_scores as CritiqueDimension[])
    : [];
  return {
    id: row.id,
    overall_score: row.overall_score,
    created_at: row.created_at,
    top_priority: deriveCritiquePriorities(dimensions)[0] ?? null,
  };
}

/**
 * Joins each resume (newest first, as listed) with its latest critique
 * summary. Critique rows for resumes not in `resumes` are ignored, so a
 * stray row can never surface under the wrong resume.
 */
export function buildResumeOverview(
  resumes: readonly ResumeListItem[],
  critiques: readonly CritiqueSummaryInput[],
): DashboardResume[] {
  const byResume = new Map<string, CritiqueSummaryInput>();
  for (const row of critiques) {
    const existing = byResume.get(row.resume_id);
    if (!existing || Date.parse(row.created_at) > Date.parse(existing.created_at)) {
      byResume.set(row.resume_id, row);
    }
  }
  return resumes.map((resume) => {
    const row = byResume.get(resume.id);
    return {
      id: resume.id,
      file_name: resume.file_name,
      file_type: resume.file_type,
      created_at: resume.created_at,
      critique: row ? toCritiqueSummary(row) : null,
    };
  });
}

/** How many recent matches the dashboard scans before picking the top ones. */
export const TOP_MATCHES_SCAN_LIMIT = 20;
/** How many matches the "Top matches" panel shows. */
export const TOP_MATCHES_COUNT = 3;

/** Highest score first; ties go to the more recent match. Never mutates the input. */
export function pickTopMatches<T extends Pick<RecentMatch, "score" | "created_at">>(
  matches: readonly T[],
  count: number = TOP_MATCHES_COUNT,
): T[] {
  return [...matches]
    .sort(
      (a, b) =>
        b.score - a.score || Date.parse(b.created_at) - Date.parse(a.created_at),
    )
    .slice(0, Math.max(0, count));
}

/** The kind the critique is charged to (§13.20.1 decision 3). */
export const CRITIQUE_RATE_LIMIT_KIND = "resume_report";

/**
 * The `resume_report` row from `getMyRateLimits` as a quota, or `null` if
 * that kind isn't configured. `remaining` never goes below 0.
 */
export function critiqueQuotaFrom(
  limits: readonly { kind: string; daily_limit: number; used_today: number; resets_at: string }[],
): CritiqueQuota | null {
  const row = limits.find((limit) => limit.kind === CRITIQUE_RATE_LIMIT_KIND);
  if (!row) return null;
  const limit = Math.max(0, row.daily_limit);
  const used = Math.max(0, row.used_today);
  return { limit, used, remaining: Math.max(0, limit - used), resetsAt: row.resets_at };
}

/** "3 of 5 critiques left today" / "1 of 5 critique left today" / "0 of 5 …". */
export function quotaHeadline(quota: CritiqueQuota): string {
  return `${quota.remaining} of ${quota.limit} ${quota.limit === 1 ? "critique" : "critiques"} left today`;
}

// ---------------------------------------------------------------------
// Next best step
// ---------------------------------------------------------------------

export type NextStep =
  /** The resume list failed to load: no recommendation can be made. */
  | { kind: "unavailable" }
  | { kind: "upload" }
  | {
      kind: "run_critique";
      resume: Pick<DashboardResume, "id" | "file_name">;
      /** True when today's critique allowance is used up. */
      quotaExhausted: boolean;
    }
  | {
      kind: "fix_priority";
      resume: Pick<DashboardResume, "id" | "file_name">;
      score: number;
      /** Null only for a malformed critique row without dimensions. */
      priority: CritiquePriority | null;
    }
  | { kind: "view_matches"; match: RecentMatch }
  | { kind: "find_matches" };

export interface NextSteps {
  primary: NextStep;
  /** Up to two lighter follow-ups shown under the primary step. */
  followUps: NextStep[];
}

/**
 * Derives "what should I do next?" from the dashboard data, in priority order:
 * 1. resumes failed to load → `unavailable` (never guess);
 * 2. no resume → `upload`;
 * 3. the newest resume has no critique → `run_critique` on it;
 * 4. it has one → `fix_priority` (its top fix);
 * 5. if critique scores failed to load, the best match (or finding one) leads instead.
 * Follow-ups: the best match if any (`view_matches`), else `find_matches`
 * once a critique exists. Matches that failed to load add no follow-up.
 */
export function deriveNextSteps(data: DashboardData): NextSteps {
  if (data.resumes.status === "error") {
    return { primary: { kind: "unavailable" }, followUps: [] };
  }

  const { items, critiquesFailed } = data.resumes.data;
  if (items.length === 0) {
    return { primary: { kind: "upload" }, followUps: [] };
  }

  const bestMatch =
    data.matches.status === "ok" && data.matches.data.length > 0
      ? pickTopMatches(data.matches.data, 1)[0]
      : null;
  const matchStep: NextStep | null = bestMatch
    ? { kind: "view_matches", match: bestMatch }
    : data.matches.status === "ok"
      ? { kind: "find_matches" }
      : null;

  if (critiquesFailed) {
    return matchStep
      ? { primary: matchStep, followUps: [] }
      : { primary: { kind: "unavailable" }, followUps: [] };
  }

  const newest = items[0];
  const resume = { id: newest.id, file_name: newest.file_name };

  if (!newest.critique) {
    const quotaExhausted =
      data.quota.status === "ok" && data.quota.data !== null && data.quota.data.remaining === 0;
    return {
      primary: { kind: "run_critique", resume, quotaExhausted },
      // Before a critique, only an existing match is worth surfacing.
      followUps: bestMatch ? [{ kind: "view_matches", match: bestMatch }] : [],
    };
  }

  return {
    primary: {
      kind: "fix_priority",
      resume,
      score: newest.critique.overall_score,
      priority: newest.critique.top_priority,
    },
    followUps: matchStep ? [matchStep] : [],
  };
}

export interface NextStepContent {
  /** Small label above the title, e.g. "Top fix · Impact & results". */
  eyebrow: string;
  title: string;
  body: string | null;
  cta: { label: string; href: string } | null;
}

/** Anchor of the "Resume critique" card on the resume page (`app/resumes/[id]/page.tsx`). */
export const CRITIQUE_ANCHOR = "resume-critique-heading";

export function resumeCritiqueHref(resumeId: string): string {
  return `/resumes/${encodeURIComponent(resumeId)}#${CRITIQUE_ANCHOR}`;
}

export function jobHref(jobDescriptionId: string): string {
  return `/jobs/${encodeURIComponent(jobDescriptionId)}`;
}

/** Display copy and link for one step. Model text (`top_fix`) is returned verbatim as plain text. */
export function nextStepContent(step: NextStep): NextStepContent {
  switch (step.kind) {
    case "unavailable":
      return {
        eyebrow: "Next step",
        title: "We couldn't work out your next step",
        body: "Some of your data didn't load. Refresh the page to try again.",
        cta: null,
      };
    case "upload":
      return {
        eyebrow: "Start here",
        title: "Upload your resume",
        body: "Add a PDF or DOCX and Kalify will review it: an overall score, your top fixes and suggested rewrites for individual lines.",
        cta: { label: "Upload a resume", href: "/resumes" },
      };
    case "run_critique":
      return {
        eyebrow: "Next step",
        title: `Get a critique of ${step.resume.file_name}`,
        body: step.quotaExhausted
          ? "You've used today's critiques. Your allowance resets at 00:00 UTC."
          : "See your score, the three fixes that will help most, and line-by-line rewrites. Takes about a minute.",
        cta: {
          label: step.quotaExhausted ? "Open resume" : "Get a critique",
          href: resumeCritiqueHref(step.resume.id),
        },
      };
    case "fix_priority":
      return step.priority
        ? {
            eyebrow: `Top fix · ${dimensionLabel(step.priority.dimension)}`,
            title: step.priority.top_fix,
            body: `The biggest improvement for ${step.resume.file_name}, which scored ${step.score}/100.`,
            cta: { label: "See all fixes", href: resumeCritiqueHref(step.resume.id) },
          }
        : {
            eyebrow: "Next step",
            title: `Review the critique of ${step.resume.file_name}`,
            body: `It scored ${step.score}/100.`,
            cta: { label: "Open critique", href: resumeCritiqueHref(step.resume.id) },
          };
    case "view_matches": {
      const { job_description: job, score } = step.match;
      return {
        eyebrow: "Your best match",
        title: job.company ? `${job.title} at ${job.company}` : job.title,
        body: `Scored ${score}/100 against ${step.match.resume.file_name}.`,
        cta: { label: "View job", href: jobHref(job.id) },
      };
    }
    case "find_matches":
      return {
        eyebrow: "Find jobs",
        title: "Match your resume against real jobs",
        body: "Browse the job board and check how well you fit a listing.",
        cta: { label: "Browse jobs", href: "/jobs" },
      };
  }
}
