/**
 * Postgres access for the `job_descriptions` table, per
 * docs/ARCHITECTURE.md §3. Unlike `lib/supabase/queries/resumes.ts`, this
 * table is *shared* data — `SELECT` is open to any authenticated user (RLS
 * policy `job_descriptions_select_all_authenticated`), so functions here do
 * not filter reads by `user_id`. Only `createJobDescription` scopes a write
 * (`submitted_by`) to the caller, matching the
 * `job_descriptions_insert_own` RLS policy.
 *
 * Returns full DB rows — route handlers are responsible for shaping rows
 * into the public response types in `types/domain.ts` before returning
 * them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";

type Client = SupabaseClient<Database>;
export type JobDescriptionRow =
  Database["public"]["Tables"]["job_descriptions"]["Row"];

/** Thrown when a Postgres operation on `job_descriptions` fails unexpectedly. */
export class JobDescriptionQueryError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "JobDescriptionQueryError";
  }
}

/** Default/maximum page size for `listJobDescriptions`, per docs/ARCHITECTURE.md §2. */
export const JOB_DESCRIPTIONS_DEFAULT_LIMIT = 20;
export const JOB_DESCRIPTIONS_MAX_LIMIT = 100;

/**
 * A decoded pagination cursor: the `(created_at, id)` position of the last
 * row returned on the previous page.
 */
export type JobDescriptionCursor = { createdAt: string; id: string };

/**
 * Encodes a `(created_at, id)` pair into the opaque cursor string returned
 * as `next_cursor` (per docs/ARCHITECTURE.md §2). `id` is included as a
 * tiebreaker: ordering by `created_at` alone gives Postgres no guarantee
 * among rows with an identical `created_at` (plausible with bulk/seeded
 * inserts, or two inserts landing in the same instant), and a strict
 * `created_at < cursor` filter would let a tied row that wasn't returned on
 * an earlier page fall through every later page since it's never `<` the
 * cursor. Joining with `_` is safe because neither an ISO-8601 timestamp
 * nor a uuid can contain that character.
 */
export function encodeJobDescriptionCursor(
  row: Pick<JobDescriptionRow, "created_at" | "id">,
): string {
  return `${row.created_at}_${row.id}`;
}

/**
 * Decodes a cursor produced by `encodeJobDescriptionCursor`. Returns `null`
 * for a malformed/unparseable cursor rather than throwing — an invalid
 * cursor degrades to "no filter" (start from the newest row) instead of a
 * hard failure, which is an acceptable default for this shared, read-only
 * listing.
 */
// Both halves are validated against a strict shape before being interpolated
// into a PostgREST `.or()` filter string below — `created_at`/`id` never
// come from a trusted source (the cursor is a client-supplied query param),
// so a value containing filter-syntax characters (`,`, `(`, `)`, etc.) must
// never reach that string unchecked.
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeJobDescriptionCursor(
  raw: string,
): JobDescriptionCursor | null {
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
 * Lists job descriptions across all users (shared data), ordered by
 * `created_at desc, id desc` — `id` is a secondary sort key purely to make
 * the ordering deterministic when two rows share a `created_at`, which in
 * turn makes keyset pagination correct (see `encodeJobDescriptionCursor`).
 * Cursor pagination: pass the opaque cursor from the previous page's
 * `next_cursor` to fetch the next page, filtered as
 * `(created_at, id) < (cursor.createdAt, cursor.id)` in row-value order
 * (expressed via `.or()` since supabase-js has no direct tuple-comparison
 * builder method). Fetches `limit + 1` rows so the caller can tell whether
 * another page exists without a separate count query; `hasMore` is true
 * when that extra row was found (in which case it is trimmed off `items`).
 */
export async function listJobDescriptions(
  supabase: Client,
  params: { limit?: number; cursor?: string | null },
): Promise<{ items: JobDescriptionRow[]; hasMore: boolean }> {
  const limit = Math.min(
    Math.max(1, params.limit ?? JOB_DESCRIPTIONS_DEFAULT_LIMIT),
    JOB_DESCRIPTIONS_MAX_LIMIT,
  );

  let query = supabase
    .from("job_descriptions")
    .select("*")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (params.cursor) {
    const decoded = decodeJobDescriptionCursor(params.cursor);
    if (decoded) {
      query = query.or(
        `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
      );
    }
  }

  const { data, error } = await query;

  if (error) {
    throw new JobDescriptionQueryError(
      `Failed to list job descriptions: ${error.message}`,
      error,
    );
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;

  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

/**
 * Fetches a single job description by id. Returns `null` if it doesn't
 * exist — callers turn that into a `404`. No ownership scoping: this is
 * shared data readable by any authenticated user, per
 * docs/ARCHITECTURE.md §1/§2.
 */
export async function getJobDescriptionById(
  supabase: Client,
  id: string,
): Promise<JobDescriptionRow | null> {
  const { data, error } = await supabase
    .from("job_descriptions")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new JobDescriptionQueryError(
      `Failed to fetch job description ${id}: ${error.message}`,
      error,
    );
  }

  return data;
}

/**
 * Inserts a new `job_descriptions` row. `submittedBy` is always the caller
 * (`auth.uid()`), matching the `job_descriptions_insert_own` RLS policy —
 * never trust a client-supplied owner.
 */
export async function createJobDescription(
  supabase: Client,
  params: {
    submittedBy: string;
    title: string;
    company?: string | null;
    description: string;
    sourceUrl?: string | null;
  },
): Promise<JobDescriptionRow> {
  const { data, error } = await supabase
    .from("job_descriptions")
    .insert({
      submitted_by: params.submittedBy,
      title: params.title,
      company: params.company ?? null,
      description: params.description,
      source_url: params.sourceUrl ?? null,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new JobDescriptionQueryError(
      `Failed to create job description: ${error?.message ?? "no row returned"}`,
      error,
    );
  }

  return data;
}
