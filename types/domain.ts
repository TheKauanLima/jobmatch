/**
 * App-level types layered on `types/database.ts`, shared by both frontend
 * components and API route handlers (per docs/ARCHITECTURE.md §3). These
 * mirror the exact JSON shapes documented in ARCHITECTURE.md §2 ("API
 * contracts") — keep the two in sync.
 */

import type { Database, ResumeStatus } from "@/types/database";

export type { ResumeStatus };

export type ResumeRow = Database["public"]["Tables"]["resumes"]["Row"];

/**
 * Public shape of a resume as returned by `POST /api/resumes` and
 * `GET /api/resumes` (list). Deliberately omits `user_id` (redundant — the
 * caller is always the owner) and `storage_path` (an internal Storage
 * bucket key with no use on the client) as well as `extracted_text` (large,
 * fetched separately via resume detail).
 */
export type ResumeListItem = {
  id: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  status: ResumeStatus;
  created_at: string;
};

/**
 * Public shape of a resume as returned by `GET /api/resumes/:id` (detail).
 * Same omissions as `ResumeListItem`, plus `extracted_text` and
 * `updated_at`.
 */
export type ResumeDetail = ResumeListItem & {
  updated_at: string;
  extracted_text: string | null;
};

/** Shapes a full DB row into the public list-response representation. */
export function toResumeListItem(row: ResumeRow): ResumeListItem {
  return {
    id: row.id,
    file_name: row.file_name,
    file_type: row.file_type,
    file_size_bytes: row.file_size_bytes,
    status: row.status,
    created_at: row.created_at,
  };
}

/** Shapes a full DB row into the public detail-response representation. */
export function toResumeDetail(row: ResumeRow): ResumeDetail {
  return {
    ...toResumeListItem(row),
    updated_at: row.updated_at,
    extracted_text: row.extracted_text,
  };
}

// ---------------------------------------------------------------------
// Resume analyses — POST /api/resumes/:id/analyze, GET /api/resumes/:id/analysis
// ---------------------------------------------------------------------

export type ResumeAnalysisRow =
  Database["public"]["Tables"]["resume_analyses"]["Row"];

/** A single strength or weakness point extracted from a resume analysis. */
export type AnalysisPoint = { label: string; detail: string };

/**
 * Public shape of a resume analysis as returned by `POST
 * /api/resumes/:id/analyze` and `GET /api/resumes/:id/analysis` (see
 * docs/ARCHITECTURE.md §2). Mirrors `resume_analyses`' jsonb columns decoded
 * into typed arrays; omits `user_id` (redundant — caller is always the
 * owner).
 */
export type ResumeAnalysis = {
  id: string;
  resume_id: string;
  strengths: AnalysisPoint[];
  weaknesses: AnalysisPoint[];
  summary: string | null;
  suggested_roles: string[];
  model: string;
  created_at: string;
};

/**
 * Shapes a full `resume_analyses` DB row into the public response
 * representation. `strengths`/`weaknesses`/`suggested_roles` are stored as
 * `jsonb` — rows only get inserted via
 * `lib/supabase/queries/analyses.ts#createAnalysis` from a
 * `lib/claude/parse.ts`-validated result, so the cast here is safe.
 */
export function toResumeAnalysis(row: ResumeAnalysisRow): ResumeAnalysis {
  return {
    id: row.id,
    resume_id: row.resume_id,
    strengths: (row.strengths as AnalysisPoint[] | null) ?? [],
    weaknesses: (row.weaknesses as AnalysisPoint[] | null) ?? [],
    summary: row.summary,
    suggested_roles: (row.suggested_roles as string[] | null) ?? [],
    model: row.model,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------
// Job descriptions — POST /api/job-descriptions, GET /api/job-descriptions,
// GET /api/job-descriptions/:id
// ---------------------------------------------------------------------

export type JobDescriptionRow =
  Database["public"]["Tables"]["job_descriptions"]["Row"];

/**
 * Public shape of a job description as returned by all three
 * `/api/job-descriptions` endpoints (per docs/ARCHITECTURE.md §2 — the
 * create/list/detail responses all use the same full-row shape, unlike
 * resumes which split list vs. detail). Omits nothing internal: unlike
 * `resumes`, there is no `storage_path`-style internal field, and
 * `submitted_by` has no client use (the submitter isn't otherwise exposed
 * in the UI per the folder structure in §3) so it's dropped too.
 */
export type JobDescription = {
  id: string;
  title: string;
  company: string | null;
  description: string;
  source_url: string | null;
  created_at: string;
  updated_at: string;
};

/** Shapes a full DB row into the public response representation. */
export function toJobDescription(row: JobDescriptionRow): JobDescription {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    description: row.description,
    source_url: row.source_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------
// Matches — POST /api/matches, GET /api/matches, GET /api/matches/:id
// ---------------------------------------------------------------------

export type MatchRow = Database["public"]["Tables"]["matches"]["Row"];

/** The joined `job_descriptions` summary inlined on every match response, per docs/ARCHITECTURE.md §2. */
export type MatchJobDescriptionSummary = {
  id: string;
  title: string;
  company: string | null;
};

/**
 * Public shape of a match as returned by `POST /api/matches`,
 * `GET /api/matches`, and `GET /api/matches/:id` (see docs/ARCHITECTURE.md
 * §2 — all three use the exact same shape, per the documented example
 * response body). Omits `resume_id` (redundant — callers always know which
 * resume they queried/matched), `user_id` (redundant — caller is always the
 * owner), and `model` (an internal audit detail with no client use, unlike
 * `ResumeAnalysis`; kept out here strictly to match §2's documented example
 * response for matches, which does not include it).
 */
export type Match = {
  id: string;
  score: number;
  rationale: string;
  matched_strengths: string[];
  gaps: string[];
  created_at: string;
  job_description: MatchJobDescriptionSummary;
};

/**
 * Shapes a full `matches` DB row plus its joined job description summary
 * into the public response representation. `matched_strengths`/`gaps` are
 * stored as `jsonb` — rows only get inserted via
 * `lib/supabase/queries/matches.ts#createMatch` from a
 * `lib/claude/parse.ts`-validated result, so the cast here is safe.
 */
export function toMatch(row: MatchRow, jobDescription: MatchJobDescriptionSummary): Match {
  return {
    id: row.id,
    score: row.score,
    rationale: row.rationale,
    matched_strengths: (row.matched_strengths as string[] | null) ?? [],
    gaps: (row.gaps as string[] | null) ?? [],
    created_at: row.created_at,
    job_description: jobDescription,
  };
}
