/**
 * Postgres access for the `matches` table, per docs/ARCHITECTURE.md §3.
 * Same conventions as `lib/supabase/queries/resumes.ts` /
 * `lib/supabase/queries/analyses.ts`: every function takes the RLS-scoped
 * server client (never `lib/supabase/admin.ts`) and additionally filters
 * reads/writes by `user_id` explicitly — this is the API-level half of the
 * "checked twice" ownership model in docs/ARCHITECTURE.md §2 (RLS is the
 * real guarantee; the explicit filter here lets a "no row" result collapse
 * cleanly into a `404` at the route handler instead of relying solely on
 * RLS silently returning nothing).
 *
 * `matches` is a history table (docs/ARCHITECTURE.md §1) — there is no
 * update/delete here, only inserts and reads.
 *
 * `listMatchesForResume`/`getMatchById` additionally join in a
 * `job_description` summary (`id`/`title`/`company`) per the response shape
 * documented in docs/ARCHITECTURE.md §2, since `GET /api/matches` and
 * `GET /api/matches/:id` both need it and the route handler otherwise has
 * no already-loaded job description to attach (unlike `POST /api/matches`,
 * which loads the job description earlier in its own flow to build the
 * Claude prompt and can attach it directly — see `createMatch`, which
 * intentionally returns the plain row without a join for that reason).
 * `job_descriptions` is shared/immutable data (§1) and every `matches` row
 * has `job_description_id` as a `not null ... on delete cascade` foreign
 * key, so a match can never legitimately reference a missing job
 * description — the fallback summary below is defensive, not an expected
 * runtime path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";
import type { MatchResult } from "@/lib/claude/parse";
import { getJobDescriptionById, getJobDescriptionsByIds } from "@/lib/supabase/queries/jobDescriptions";

type Client = SupabaseClient<Database>;
export type MatchRow = Database["public"]["Tables"]["matches"]["Row"];

/** Thrown when a Postgres operation on `matches` fails unexpectedly. */
export class MatchQueryError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MatchQueryError";
  }
}

export type MatchJobDescriptionSummary = {
  id: string;
  title: string;
  company: string | null;
};

export type MatchWithJobDescription = MatchRow & {
  job_description: MatchJobDescriptionSummary;
};

/** Fallback summary attached if a match's job description is unexpectedly missing (see module docstring). */
function fallbackJobDescriptionSummary(jobDescriptionId: string): MatchJobDescriptionSummary {
  return { id: jobDescriptionId, title: "(job description unavailable)", company: null };
}

/**
 * Lists the caller's own matches for a single resume, scoped by both
 * `resume_id` AND `user_id`, ordered by `created_at desc`. Does not verify
 * the resume itself is owned by the caller — route handlers are expected to
 * check that separately (see `app/api/matches/route.ts`) so a
 * not-owned/nonexistent `resume_id` cleanly yields `404` rather than an
 * empty `200` list.
 */
export async function listMatchesForResume(
  supabase: Client,
  userId: string,
  resumeId: string,
): Promise<MatchWithJobDescription[]> {
  const { data, error } = await supabase
    .from("matches")
    .select("*")
    .eq("resume_id", resumeId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new MatchQueryError(
      `Failed to list matches for resume ${resumeId}: ${error.message}`,
      error,
    );
  }

  const rows = data ?? [];
  if (rows.length === 0) {
    return [];
  }

  const jobDescriptionIds = Array.from(new Set(rows.map((row) => row.job_description_id)));
  const jobDescriptions = await getJobDescriptionsByIds(supabase, jobDescriptionIds);
  const jobDescriptionById = new Map(jobDescriptions.map((jd) => [jd.id, jd]));

  return rows.map((row) => {
    const jd = jobDescriptionById.get(row.job_description_id);
    return {
      ...row,
      job_description: jd
        ? { id: jd.id, title: jd.title, company: jd.company }
        : fallbackJobDescriptionSummary(row.job_description_id),
    };
  });
}

/**
 * Fetches a single match by id, scoped to its owner. Returns `null` if it
 * doesn't exist or isn't owned by `userId` — callers turn that into a `404`
 * (never a `403`, per docs/ARCHITECTURE.md §2, to avoid leaking existence
 * of other users' rows).
 */
export async function getMatchById(
  supabase: Client,
  userId: string,
  id: string,
): Promise<MatchWithJobDescription | null> {
  const { data, error } = await supabase
    .from("matches")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new MatchQueryError(
      `Failed to fetch match ${id}: ${error.message}`,
      error,
    );
  }

  if (!data) {
    return null;
  }

  const jobDescription = await getJobDescriptionById(supabase, data.job_description_id);

  return {
    ...data,
    job_description: jobDescription
      ? { id: jobDescription.id, title: jobDescription.title, company: jobDescription.company }
      : fallbackJobDescriptionSummary(data.job_description_id),
  };
}

/**
 * Inserts a new `matches` row from a validated Claude response
 * (`lib/claude/parse.ts#parseMatchResponse`). `matches` is append-only
 * history (docs/ARCHITECTURE.md §1) — a re-run match always inserts a new
 * row rather than mutating a prior one. Returns the plain row (no
 * `job_description` join) since `POST /api/matches` already has the job
 * description loaded from earlier in its own flow (see module docstring).
 */
export async function createMatch(
  supabase: Client,
  params: {
    resumeId: string;
    jobDescriptionId: string;
    userId: string;
    model: string;
    result: MatchResult;
  },
): Promise<MatchRow> {
  const { data, error } = await supabase
    .from("matches")
    .insert({
      resume_id: params.resumeId,
      job_description_id: params.jobDescriptionId,
      user_id: params.userId,
      score: params.result.score,
      rationale: params.result.rationale,
      matched_strengths: params.result.matched_strengths,
      gaps: params.result.gaps,
      model: params.model,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new MatchQueryError(
      `Failed to create match for resume ${params.resumeId}: ${
        error?.message ?? "no row returned"
      }`,
      error,
    );
  }

  return data;
}
