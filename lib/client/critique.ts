import { formatLocalDateTime } from "@/lib/client/formatDateTime";
import type {
  Critique,
  CritiqueDimensionKey,
  CritiqueIssueType,
  CritiqueSection,
  CritiqueStudentStage,
  LineFeedback,
} from "@/types/domain";

/**
 * Client-side helpers for the V1 resume critique (docs/ARCHITECTURE.md
 * §13.20.4, §13.20.6): display labels, score bands, the
 * `POST /api/resumes/:id/critique` request, and the response → UI-state and
 * copy mapping. React-free so the components in `components/reports/` and
 * `components/resumes/RunCritiqueButton.tsx` only render what this returns.
 *
 * Nothing here logs or stores resume or critique text.
 */

// ---------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------

/** §13.20.6 dimension labels (binding). */
export const DIMENSION_LABELS: Record<CritiqueDimensionKey, string> = {
  impact: "Impact & results",
  clarity: "Clarity",
  relevance: "Relevance",
  structure: "Structure & formatting",
  ats_readability: "ATS readability",
};

export const ISSUE_TYPE_LABELS: Record<CritiqueIssueType, string> = {
  no_metric: "No measurable result",
  weak_verb: "Weak verb",
  vague: "Vague",
  too_long: "Too long",
  passive_voice: "Passive voice",
  jargon: "Jargon",
  typo_grammar: "Typo or grammar",
  formatting: "Formatting",
  irrelevant: "Not relevant",
};

export const SECTION_LABELS: Record<CritiqueSection, string> = {
  experience: "Experience",
  projects: "Projects",
  education: "Education",
  leadership: "Leadership & activities",
  skills: "Skills",
  summary: "Summary",
  other: "Other",
};

export const STUDENT_STAGE_LABELS: Record<CritiqueStudentStage, string> = {
  early_student: "Early-stage student",
  late_student: "Late-stage student",
  new_grad: "New graduate",
  experienced: "Experienced candidate",
};

/** Turns an unknown snake_case key into readable text ("foo_bar" → "Foo bar"). */
function humanize(key: string): string {
  const text = key.replace(/_/g, " ").trim();
  return text.length === 0 ? key : text.charAt(0).toUpperCase() + text.slice(1);
}

function lookup<K extends string>(labels: Record<K, string>, key: string): string {
  return Object.prototype.hasOwnProperty.call(labels, key)
    ? labels[key as K]
    : humanize(key);
}

// Lookups tolerate values outside today's enums (e.g. a stored row written
// by a later prompt version) instead of rendering `undefined`.
export const dimensionLabel = (key: string) => lookup(DIMENSION_LABELS, key);
export const issueTypeLabel = (key: string) => lookup(ISSUE_TYPE_LABELS, key);
export const sectionLabel = (key: string) => lookup(SECTION_LABELS, key);
export const studentStageLabel = (key: string) => lookup(STUDENT_STAGE_LABELS, key);

// ---------------------------------------------------------------------
// Score bands (§13.20.6: same three tokens as MatchScoreBadge)
// ---------------------------------------------------------------------

export type ScoreBandKey = "strong" | "polish" | "work";

export interface ScoreBand {
  key: ScoreBandKey;
  label: string;
}

/** ≥ 75 "Strong"; 50–74 "Needs polish"; < 50 "Needs work". */
export function scoreBand(score: number): ScoreBand {
  if (score >= 75) return { key: "strong", label: "Strong" };
  if (score >= 50) return { key: "polish", label: "Needs polish" };
  return { key: "work", label: "Needs work" };
}

/** Clamps a score into 0..100 for widths/arcs; the text always shows the real value. */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, score));
}

// ---------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------

export interface TextSegment {
  text: string;
  placeholder: boolean;
}

/**
 * Splits a suggested rewrite into plain text and `[bracketed]` placeholder
 * segments so placeholders can be visually marked (§13.20.6). Returns plain
 * strings only; the caller renders them as React text, never HTML. An
 * unmatched `[` stays plain text.
 */
export function splitPlaceholders(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const pattern = /\[[^[\]\n]+\]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: text.slice(last, start), placeholder: false });
    segments.push({ text: match[0], placeholder: true });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), placeholder: false });
  return segments;
}

/** How many line-feedback items show before "Show all N" (§13.20.6). */
export const LINE_FEEDBACK_INITIAL_COUNT = 6;

export interface LineFeedbackGroup {
  section: string;
  label: string;
  items: LineFeedback[];
}

/**
 * Groups line feedback by section. Items arrive most impactful first
 * (§13.20.3), so sections are ordered by their first item and items keep
 * their relative order inside each group.
 */
export function groupLineFeedback(items: readonly LineFeedback[]): LineFeedbackGroup[] {
  const groups = new Map<string, LineFeedbackGroup>();
  for (const item of items) {
    let group = groups.get(item.section);
    if (!group) {
      group = { section: item.section, label: sectionLabel(item.section), items: [] };
      groups.set(item.section, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

/**
 * Formats the critique date deterministically (UTC, en-US) so a server
 * render and a client render always agree, e.g. "Nov 17, 2026".
 */
export function formatCritiqueDate(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(ms));
}

/** "0:07", "1:42", "12:05": elapsed time shown while a critique runs. */
export function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------

/**
 * Daily `resume_report` allowance shown in the empty state (§13.9.3; the
 * critique shares this quota, §13.20.1 decision 3). Display only: the
 * server enforces the real limit, and Settings shows live usage.
 */
export const RESUME_REPORT_DAILY_LIMIT = 5;

export const CRITIQUE_COPY = {
  emptyDescription:
    "Get a detailed review of this resume: an overall score, scores for impact, clarity, relevance, structure and ATS readability, your top 3 fixes, and suggested rewrites for individual lines.",
  emptyQuota: `Takes about a minute and uses 1 of your ${RESUME_REPORT_DAILY_LIMIT} daily resume reports.`,
  runLabel: "Run critique",
  rerunLabel: "Run updated critique",
  runningLabel: "Reviewing…",
  /** §13.20.6 pending copy (binding meaning). */
  running: "Reviewing your resume. This usually takes under a minute; keep this tab open.",
  stale: "An updated critique is available. Running it uses 1 of your daily resume reports.",
  footer:
    "AI-generated feedback. Review before using; bracketed values are placeholders for your real numbers.",
  needsInputTag: "Needs your numbers",
  needsInputHint: "Replace the [bracketed] parts with your real figures before using this line.",
  // Errors (§13.13.9 + §13.20.4 budget_exhausted; wording polished, meaning kept).
  unauthorized: "Your session has ended. Log in again to run the critique.",
  notFound: "We couldn't find this resume. It may have been deleted.",
  textExtractionFailed:
    "We couldn't read text from this file. Try a PDF exported from your editor, or a DOCX.",
  rateLimitedFallback:
    "You've used all of today's resume reports. You can run another after 00:00 UTC.",
  budgetExhaustedFallback:
    "Kalify's AI features have reached today's capacity. Try again after 00:00 UTC.",
  systemError:
    "Something went wrong on our side. Retry, and this one won't count toward your daily limit.",
  modelError: "We couldn't finish the critique. Please retry.",
  /**
   * Network failure, a gateway timeout, or an unexpected status. The run
   * may have finished server-side; a refresh shows it, and a retry of a
   * finished run returns the stored critique at no charge.
   */
  uncertain:
    "We lost the connection before the critique finished. It may still have completed: refresh the page to check before running it again.",
} as const;

export function rateLimitedMessage(retryAfter: string | null): string {
  const when = formatLocalDateTime(retryAfter);
  return when
    ? `You've used all of today's resume reports. You can run another after ${when}.`
    : CRITIQUE_COPY.rateLimitedFallback;
}

export function budgetExhaustedMessage(retryAfter: string | null): string {
  const when = formatLocalDateTime(retryAfter);
  return when
    ? `Kalify's AI features have reached today's capacity. Try again after ${when}.`
    : CRITIQUE_COPY.budgetExhaustedFallback;
}

// ---------------------------------------------------------------------
// POST /api/resumes/:id/critique → outcome → UI result
// ---------------------------------------------------------------------

export type CritiqueRunOutcome =
  /** 201 (new) or 200 (cached, or a concurrent run won the race). */
  | { kind: "ok"; created: boolean }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "text_extraction_failed" }
  | { kind: "rate_limited"; retryAfter: string | null }
  | { kind: "budget_exhausted"; retryAfter: string | null }
  /** `ai_unavailable` / `internal_error`: refunded (§13.20.4). */
  | { kind: "system_error" }
  /** `ai_refused` / `ai_invalid_output` / `ai_truncated` / `ai_bad_request`. */
  | { kind: "model_error" }
  | { kind: "uncertain" };

const MODEL_ERROR_CODES = new Set([
  "ai_refused",
  "ai_invalid_output",
  "ai_truncated",
  "ai_bad_request",
]);

function readBody(body: unknown): { code: string | null; retryAfter: string | null } {
  if (body === null || typeof body !== "object") return { code: null, retryAfter: null };
  const record = body as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : null,
    retryAfter: typeof record.retry_after === "string" ? record.retry_after : null,
  };
}

/**
 * Maps a POST response to an outcome per the §13.20.4 contract. Only the
 * status and the body's `code` / `retry_after` are read; the critique
 * itself is re-fetched by the page's GET after `router.refresh()`.
 */
export async function interpretCritiqueResponse(
  response: Pick<Response, "status" | "json">,
): Promise<CritiqueRunOutcome> {
  const { status } = response;
  if (status === 200 || status === 201) return { kind: "ok", created: status === 201 };
  if (status === 401) return { kind: "unauthorized" };

  const { code, retryAfter } = readBody(await response.json().catch(() => null));

  switch (status) {
    case 404:
      return { kind: "not_found" };
    case 422:
      return code === "text_extraction_failed"
        ? { kind: "text_extraction_failed" }
        : { kind: "uncertain" };
    case 429:
      return { kind: "rate_limited", retryAfter };
    case 503:
      // A platform 503 (no JSON code) is not the budget gate.
      return code === "budget_exhausted"
        ? { kind: "budget_exhausted", retryAfter }
        : { kind: "uncertain" };
    case 502:
      if (code === "ai_unavailable") return { kind: "system_error" };
      if (code !== null && MODEL_ERROR_CODES.has(code)) return { kind: "model_error" };
      // A gateway 502 without our JSON body: the run may still finish.
      return { kind: "uncertain" };
    case 500:
      return code === "internal_error" ? { kind: "system_error" } : { kind: "uncertain" };
    default:
      return { kind: "uncertain" };
  }
}

/** Sends the POST and maps the result. Never throws. */
export async function requestCritiqueRun(
  resumeId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CritiqueRunOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`/api/resumes/${encodeURIComponent(resumeId)}/critique`, {
      method: "POST",
      cache: "no-store",
    });
  } catch {
    return { kind: "uncertain" };
  }
  return interpretCritiqueResponse(response);
}

export type CritiqueRunResult =
  | { type: "refresh" }
  | {
      type: "error";
      message: string;
      /** Show a "Log in" link. */
      showLogin: boolean;
      /** Show a "Refresh page" action (the run may have completed). */
      showRefresh: boolean;
    };

function error(message: string, extra: Partial<{ showLogin: boolean; showRefresh: boolean }> = {}) {
  return {
    type: "error" as const,
    message,
    showLogin: extra.showLogin ?? false,
    showRefresh: extra.showRefresh ?? false,
  };
}

/** Turns an outcome into what the button does next. */
export function outcomeToRunResult(outcome: CritiqueRunOutcome): CritiqueRunResult {
  switch (outcome.kind) {
    case "ok":
      return { type: "refresh" };
    case "unauthorized":
      return error(CRITIQUE_COPY.unauthorized, { showLogin: true });
    case "not_found":
      return error(CRITIQUE_COPY.notFound);
    case "text_extraction_failed":
      return error(CRITIQUE_COPY.textExtractionFailed);
    case "rate_limited":
      return error(rateLimitedMessage(outcome.retryAfter));
    case "budget_exhausted":
      return error(budgetExhaustedMessage(outcome.retryAfter));
    case "system_error":
      return error(CRITIQUE_COPY.systemError);
    case "model_error":
      return error(CRITIQUE_COPY.modelError);
    case "uncertain":
      return error(CRITIQUE_COPY.uncertain, { showRefresh: true });
  }
}

// ---------------------------------------------------------------------
// GET /api/resumes/:id/critique (server page)
// ---------------------------------------------------------------------

export type CritiqueLoadResult =
  | { kind: "ok"; critique: Critique }
  | { kind: "none" }
  | { kind: "error" };

function isCritique(value: unknown): value is Critique {
  if (value === null || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.overall_score === "number" &&
    typeof c.summary === "string" &&
    Array.isArray(c.dimensions) &&
    Array.isArray(c.priorities) &&
    Array.isArray(c.line_feedback) &&
    Array.isArray(c.ats_issues) &&
    Array.isArray(c.missing_sections)
  );
}

/**
 * Maps a GET response: `200 { critique }` → ok; `404 no_critique` → the
 * empty state; anything else (including a malformed body) → error. The
 * page only calls this after the resume itself loaded, so a `404
 * not_found` here is a race with deletion and is reported as an error.
 */
export async function interpretCritiqueLoad(
  response: Pick<Response, "status" | "json">,
): Promise<CritiqueLoadResult> {
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 200) {
    const critique =
      body !== null && typeof body === "object"
        ? (body as Record<string, unknown>).critique
        : undefined;
    return isCritique(critique) ? { kind: "ok", critique } : { kind: "error" };
  }
  if (response.status === 404 && readBody(body).code === "no_critique") {
    return { kind: "none" };
  }
  return { kind: "error" };
}
