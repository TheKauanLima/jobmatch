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
import { getResumesByIds } from "@/lib/supabase/queries/resumes";
import { isInvalidInputSyntaxError } from "@/lib/supabase/postgresErrors";

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
  deleted_at: string | null;
};

export type MatchWithJobDescription = MatchRow & {
  job_description: MatchJobDescriptionSummary;
};

/**
 * Fallback summary attached if a match's job description is unexpectedly
 * missing (see module docstring). `deleted_at: null` here specifically
 * because this is a different, unrelated failure mode from a soft delete
 * (per docs/ARCHITECTURE.md §10.4) — a genuinely missing row, not a
 * `deleted_at`-set one (which `getJobDescriptionById`/`getJobDescriptionsByIds`
 * still resolve normally, per §10.2).
 */
function fallbackJobDescriptionSummary(jobDescriptionId: string): MatchJobDescriptionSummary {
  return {
    id: jobDescriptionId,
    title: "(job description unavailable)",
    company: null,
    deleted_at: null,
  };
}

export type MatchResumeSummary = { id: string; file_name: string };

/** Fallback summary attached if a match's resume is unexpectedly missing (see module docstring). */
function fallbackResumeSummary(resumeId: string): MatchResumeSummary {
  return { id: resumeId, file_name: "(resume unavailable)" };
}

export type RecentMatchWithContext = MatchRow & {
  job_description: MatchJobDescriptionSummary;
  resume: MatchResumeSummary;
};

/** Default/maximum result count for `listRecentMatchesForUser`. */
export const RECENT_MATCHES_DEFAULT_LIMIT = 5;
/**
 * Raised from 20 to 50 per docs/ARCHITECTURE.md §11.1: this mode now backs
 * both the dashboard's 5-item "Latest matches" widget (unaffected, per
 * `RECENT_MATCHES_DEFAULT_LIMIT` above) and the full `/matches` history
 * page's "Load more" pagination, which wants a page-sized cap higher than a
 * dashboard widget ever needed.
 */
export const RECENT_MATCHES_MAX_LIMIT = 50;

/**
 * A decoded pagination cursor for `listRecentMatchesForUser`: the
 * `(created_at, id)` position of the last row returned on the previous
 * page. A `matches`-specific compound token, deliberately **not** shared
 * with `job_descriptions`' cursor codec in
 * `lib/supabase/queries/jobDescriptions.ts` — per docs/ARCHITECTURE.md
 * §11.1, these two tables' pagination just happens to look alike; there's
 * no reason to couple them through shared code for that.
 */
export type MatchCursor = { createdAt: string; id: string };

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encodes a `(created_at, id)` pair into the opaque cursor string returned
 * as `next_cursor` by `GET /api/matches` (no `resume_id`), per
 * docs/ARCHITECTURE.md §11.1. `id` is included as a tiebreaker for the same
 * reason `encodeJobDescriptionCursor` includes one: ordering by `created_at`
 * alone gives Postgres no guarantee among rows with an identical
 * `created_at`, and a strict `created_at < cursor` filter would let a tied
 * row that wasn't returned on an earlier page fall through every later page.
 */
export function encodeMatchCursor(row: Pick<MatchRow, "created_at" | "id">): string {
  return `${row.created_at}_${row.id}`;
}

/**
 * Decodes a cursor produced by `encodeMatchCursor`. Returns `null` for a
 * malformed/unparseable cursor rather than throwing — an invalid cursor
 * degrades to "no filter" (first page) instead of a hard failure, same
 * "malformed cursor → first page" convention as
 * `decodeJobDescriptionCursor`.
 */
export function decodeMatchCursor(raw: string): MatchCursor | null {
  const separatorIndex = raw.lastIndexOf("_");
  if (separatorIndex === -1) {
    return null;
  }

  const createdAt = raw.slice(0, separatorIndex);
  const id = raw.slice(separatorIndex + 1);
  if (!ISO_TIMESTAMP_PATTERN.test(createdAt) || !UUID_PATTERN.test(id)) {
    return null;
  }

  return { createdAt, id };
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
        ? { id: jd.id, title: jd.title, company: jd.company, deleted_at: jd.deleted_at }
        : fallbackJobDescriptionSummary(row.job_description_id),
    };
  });
}

/**
 * Lists the caller's own most recent matches **across all of their
 * resumes**, ordered by `created_at desc, id desc` (the `id` tiebreak added
 * per docs/ARCHITECTURE.md §11.1 — today's dashboard-only use never needed
 * one at `limit <= 20` fetched fresh every render, but a "Load more" flow
 * that pages through history needs a deterministic order across requests,
 * the same way `job_descriptions`' keyset listing already does), joined
 * with both a `job_description` and a `resume` summary. Used by
 * `GET /api/matches` when called *without* `resume_id` (see that route's
 * docstring) to power both the dashboard's "Latest matches" panel and, per
 * §11, the full `/matches` history page.
 *
 * Cursor pagination (per §11.1, added on top of the dashboard's original
 * single-fetch use): pass the opaque cursor from the previous page's
 * `next_cursor` (see `encodeMatchCursor`) to fetch the next page, filtered
 * as `(created_at, id) < (cursor.createdAt, cursor.id)` in row-value order,
 * same `.or()` technique `listJobDescriptions` uses. Fetches `limit + 1`
 * rows so the caller can tell whether another page exists without a
 * separate count query; `hasMore` is true when that extra row was found (in
 * which case it is trimmed off `items`).
 *
 * This is safe in the way `listMatchesForResume`'s `resume_id`-scoped
 * listing already is, and does NOT reopen the enumeration hole
 * docs/ARCHITECTURE.md §2 deliberately avoids: that hole is specifically a
 * `job_description_id`-only mode with no `resume_id`, which would let a
 * caller ask "who else matched against this shared job posting" and learn
 * about *other users'* match results. This function takes no caller-supplied
 * filter at all beyond `userId` (never taken from a request param — always
 * `requireSession()`'s own `user.id`) — it can only ever return the caller's
 * own rows, exactly like every other function in this module.
 */
export async function listRecentMatchesForUser(
  supabase: Client,
  userId: string,
  params: { limit: number; cursor?: string | null },
): Promise<{ items: RecentMatchWithContext[]; hasMore: boolean }> {
  let query = supabase
    .from("matches")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(params.limit + 1);

  if (params.cursor) {
    const decoded = decodeMatchCursor(params.cursor);
    if (decoded) {
      query = query.or(
        `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
      );
    }
  }

  const { data, error } = await query;

  if (error) {
    throw new MatchQueryError(
      `Failed to list recent matches for user ${userId}: ${error.message}`,
      error,
    );
  }

  const allRows = data ?? [];
  const hasMore = allRows.length > params.limit;
  const rows = hasMore ? allRows.slice(0, params.limit) : allRows;

  if (rows.length === 0) {
    return { items: [], hasMore: false };
  }

  const jobDescriptionIds = Array.from(new Set(rows.map((row) => row.job_description_id)));
  const resumeIds = Array.from(new Set(rows.map((row) => row.resume_id)));
  const [jobDescriptions, resumes] = await Promise.all([
    getJobDescriptionsByIds(supabase, jobDescriptionIds),
    getResumesByIds(supabase, userId, resumeIds),
  ]);
  const jobDescriptionById = new Map(jobDescriptions.map((jd) => [jd.id, jd]));
  const resumeById = new Map(resumes.map((r) => [r.id, r]));

  const items = rows.map((row) => {
    const jd = jobDescriptionById.get(row.job_description_id);
    const resume = resumeById.get(row.resume_id);
    return {
      ...row,
      job_description: jd
        ? { id: jd.id, title: jd.title, company: jd.company, deleted_at: jd.deleted_at }
        : fallbackJobDescriptionSummary(row.job_description_id),
      resume: resume
        ? { id: resume.id, file_name: resume.file_name }
        : fallbackResumeSummary(row.resume_id),
    };
  });

  return { items, hasMore };
}

/**
 * Fetches a single match by id, scoped to its owner. Returns `null` if it
 * doesn't exist or isn't owned by `userId` — callers turn that into a `404`
 * (never a `403`, per docs/ARCHITECTURE.md §2, to avoid leaking existence
 * of other users' rows). Also returns `null` (rather than throwing) for a
 * malformed (non-uuid) `id` — see `lib/supabase/postgresErrors.ts` for why
 * that collapses into the same `404` instead of a misleading `500`.
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
    if (isInvalidInputSyntaxError(error)) {
      return null;
    }
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
      ? {
          id: jobDescription.id,
          title: jobDescription.title,
          company: jobDescription.company,
          deleted_at: jobDescription.deleted_at,
        }
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
