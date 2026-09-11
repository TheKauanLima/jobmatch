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

import type { Database, JobDescriptionSource } from "@/types/database";
import { isInvalidInputSyntaxError } from "@/lib/supabase/postgresErrors";

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
 * Maximum length (characters) accepted for `?q=` on
 * `GET /api/job-descriptions`, per docs/ARCHITECTURE.md §9.1/§9.3. A
 * query-param bound, same category as `JOB_DESCRIPTIONS_DEFAULT_LIMIT`/
 * `JOB_DESCRIPTIONS_MAX_LIMIT` above, not a POST-body field — so it lives
 * here rather than among the `JOB_DESCRIPTION_*_MAX_LENGTH` constants in
 * `lib/validation/schemas.ts`, matching §3's existing rule that `?level=`/
 * `?limit=` are validated inline in the route handler, not via a `zod`
 * schema.
 */
export const JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH = 200;

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
  params: { limit?: number; cursor?: string | null; level?: string | null },
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

  if (params.level) {
    query = query.eq("level", params.level);
  }

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
 * Encodes an integer offset into the opaque cursor string returned as
 * `next_cursor` for search-mode (`?q=`) pagination, per
 * docs/ARCHITECTURE.md §9.2. Deliberately a distinct string shape from
 * `encodeJobDescriptionCursor`'s `<created_at>_<id>` so a cursor produced
 * under one pagination mode simply fails the other mode's decode (see
 * `decodeJobDescriptionOffsetCursor`) rather than being silently
 * misinterpreted.
 */
export function encodeJobDescriptionOffsetCursor(offset: number): string {
  return `offset_${offset}`;
}

const OFFSET_CURSOR_PATTERN = /^offset_(\d+)$/;

/**
 * Decodes a cursor produced by `encodeJobDescriptionOffsetCursor`. Returns
 * `null` for a malformed/unparseable cursor — including a keyset cursor
 * from `encodeJobDescriptionCursor` replayed in the wrong mode — rather than
 * throwing, so it degrades to "no cursor" (first page), same "malformed
 * cursor → first page" behavior `decodeJobDescriptionCursor` already has.
 */
export function decodeJobDescriptionOffsetCursor(raw: string): number | null {
  const match = OFFSET_CURSOR_PATTERN.exec(raw);
  if (!match) {
    return null;
  }

  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) ? offset : null;
}

/**
 * Ranked full-text search over job descriptions via the
 * `search_job_descriptions` Postgres function (added by
 * `supabase/migrations/0005_job_description_search.sql`), per
 * docs/ARCHITECTURE.md §9. Structured the same way as `listJobDescriptions`:
 * fetches `limit + 1` rows so the caller can tell whether another page
 * exists without a separate count query; `hasMore` is true when that extra
 * row was found (in which case it is trimmed off `items`).
 *
 * Unlike `listJobDescriptions`'s keyset cursor, pagination here is a plain
 * integer offset (§9.2's deliberate tradeoff — see
 * `encodeJobDescriptionOffsetCursor`'s docstring and §9.2 for why a
 * rank-based keyset cursor was rejected, not just deferred).
 */
export async function searchJobDescriptions(
  supabase: Client,
  params: {
    query: string;
    limit?: number;
    offset?: number;
    level?: string | null;
  },
): Promise<{ items: JobDescriptionRow[]; hasMore: boolean }> {
  const limit = Math.min(
    Math.max(1, params.limit ?? JOB_DESCRIPTIONS_DEFAULT_LIMIT),
    JOB_DESCRIPTIONS_MAX_LIMIT,
  );
  const offset = Math.max(0, params.offset ?? 0);

  const { data, error } = await supabase.rpc("search_job_descriptions", {
    search_query: params.query,
    // `||`, not `??`: an empty string (from `?level=` present-but-empty)
    // must also fall back to "no filter," matching `listJobDescriptions`'s
    // `if (params.level) { ... }` check just above — `??` would only
    // substitute for `null`/`undefined` and let `""` through, which the
    // `search_job_descriptions` RPC's `level = level_filter` would then
    // match against literally (zero rows, since no real row has
    // `level = ''`) instead of skipping the filter as documented in
    // docs/ARCHITECTURE.md §2/§9.3 ("omitted/empty means no filter").
    level_filter: params.level || null,
    limit_count: limit + 1,
    offset_count: offset,
  });

  if (error) {
    throw new JobDescriptionQueryError(
      `Failed to search job descriptions: ${error.message}`,
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
 * docs/ARCHITECTURE.md §1/§2. Also returns `null` (rather than throwing)
 * for a malformed (non-uuid) `id` — see `lib/supabase/postgresErrors.ts`
 * for why that collapses into the same `404` instead of a misleading `500`.
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
    if (isInvalidInputSyntaxError(error)) {
      return null;
    }
    throw new JobDescriptionQueryError(
      `Failed to fetch job description ${id}: ${error.message}`,
      error,
    );
  }

  return data;
}

/**
 * Batch-fetches job descriptions by id, used by
 * `lib/supabase/queries/matches.ts` to join `title`/`company` summaries
 * onto a list of `matches` rows without an N+1 query per match. No
 * ownership scoping (shared data, same as `getJobDescriptionById`). Returns
 * `[]` immediately for an empty `ids` array rather than issuing a query with
 * an empty `.in()` filter.
 */
export async function getJobDescriptionsByIds(
  supabase: Client,
  ids: string[],
): Promise<JobDescriptionRow[]> {
  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("job_descriptions")
    .select("*")
    .in("id", ids);

  if (error) {
    throw new JobDescriptionQueryError(
      `Failed to fetch job descriptions by id: ${error.message}`,
      error,
    );
  }

  return data ?? [];
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
    location?: string | null;
    level?: string | null;
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
      location: params.location ?? null,
      level: params.level ?? null,
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

/** One externally-sourced listing, mapped and ready to upsert (see `lib/jobs/`). */
export type ExternalJobDescriptionUpsert = {
  externalId: string;
  title: string;
  company: string | null;
  description: string;
  sourceUrl: string | null;
  level: string | null;
  location: string | null;
  postedAt: string | null;
};

/** Batch size for `upsertExternalJobDescriptions` — keeps individual requests small. */
const EXTERNAL_UPSERT_BATCH_SIZE = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Upserts a batch of externally-sourced job listings (e.g. from The Muse —
 * see `lib/jobs/themuse.ts`/`lib/jobs/sync.ts`), keyed on the
 * `(source, external_id)` unique constraint added by
 * `supabase/migrations/0004_external_job_listings.sql`. Re-running a sync
 * for a listing already ingested updates that row in place (title/
 * description/location can change between syncs) rather than creating a
 * duplicate. `submitted_by` is left `null` — these rows have no JobMatch
 * user as their submitter.
 *
 * Callers MUST pass a service-role client (`lib/supabase/admin.ts`): there
 * is no authenticated user in a cron/sync context, so the
 * `job_descriptions_insert_own` RLS policy (which requires
 * `submitted_by = auth.uid()`) would reject every row under a normal
 * session-scoped client.
 *
 * Sent in batches of `EXTERNAL_UPSERT_BATCH_SIZE` to keep each Postgrest
 * request small; a full sync typically upserts a few hundred rows.
 */
export async function upsertExternalJobDescriptions(
  supabase: Client,
  source: Exclude<JobDescriptionSource, "user">,
  rows: ExternalJobDescriptionUpsert[],
): Promise<{ count: number }> {
  if (rows.length === 0) {
    return { count: 0 };
  }

  let count = 0;
  for (const batch of chunk(rows, EXTERNAL_UPSERT_BATCH_SIZE)) {
    const { error, count: batchCount } = await supabase
      .from("job_descriptions")
      .upsert(
        batch.map((row) => ({
          source,
          external_id: row.externalId,
          title: row.title,
          company: row.company,
          description: row.description,
          source_url: row.sourceUrl,
          level: row.level,
          location: row.location,
          posted_at: row.postedAt,
          submitted_by: null,
        })),
        { onConflict: "source,external_id", count: "exact" },
      );

    if (error) {
      throw new JobDescriptionQueryError(
        `Failed to upsert external job descriptions: ${error.message}`,
        error,
      );
    }

    count += batchCount ?? batch.length;
  }

  return { count };
}
