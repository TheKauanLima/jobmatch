/**
 * Postgres access for the `job_descriptions` table, per
 * docs/ARCHITECTURE.md §3. Unlike `lib/supabase/queries/resumes.ts`, this
 * table is *shared* data — `SELECT` is open to any authenticated user (RLS
 * policy `job_descriptions_select_all_authenticated`), so functions here do
 * not filter reads by `user_id`. `createJobDescription`, `updateJobDescription`,
 * and `softDeleteJobDescription` (the latter two added per
 * docs/ARCHITECTURE.md §10) all scope their writes (`submitted_by`) to the
 * caller, matching the `job_descriptions_insert_own`/`job_descriptions_update_own`
 * RLS policies.
 *
 * Returns full DB rows — route handlers are responsible for shaping rows
 * into the public response types in `types/domain.ts` before returning
 * them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, JobDescriptionSource } from "@/types/database";
import type { JobCategory } from "@/lib/jobs/categories";
import type { UsStateCode } from "@/lib/jobs/usStates";
import {
  JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH,
  JOB_DESCRIPTIONS_DEFAULT_LIMIT,
  JOB_DESCRIPTIONS_MAX_LIMIT,
} from "@/lib/jobs/listLimits";
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

/**
 * Page-size and `?q=` bounds (docs/ARCHITECTURE.md §2/§9.1/§9.3). They live
 * in the import-free `lib/jobs/listLimits.ts` so `lib/validation/schemas.ts`
 * (imported by client components) doesn't pull this query module into the
 * client bundle (§7.8.8). Re-exported here for existing callers.
 */
export {
  JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH,
  JOB_DESCRIPTIONS_DEFAULT_LIMIT,
  JOB_DESCRIPTIONS_MAX_LIMIT,
};

/**
 * A decoded pagination cursor: the `(listed_at, id)` position of the last
 * row returned on the previous page (§7.8.6; was `created_at` before 0012).
 */
export type JobDescriptionCursor = { listedAt: string; id: string };

/**
 * Encodes a `(listed_at, id)` pair into the opaque cursor string returned
 * as `next_cursor` (per docs/ARCHITECTURE.md §2/§7.8.6). `listed_at` is
 * the generated `coalesce(posted_at, created_at)`. `id` is included as a
 * tiebreaker: ordering by `listed_at` alone gives Postgres no guarantee
 * among rows with an identical value (common: one sync run inserts hundreds
 * of rows at once), and a strict `listed_at < cursor` filter would let a
 * tied row that wasn't returned on an earlier page fall through every later
 * page. Joining with `_` is safe because neither an ISO-8601 timestamp nor
 * a uuid can contain that character. Same string shape as the pre-0012
 * `<created_at>_<id>` cursor, which therefore still decodes (read as
 * `listed_at`; at worst one page seam is off, once).
 */
export function encodeJobDescriptionCursor(
  row: Pick<JobDescriptionRow, "listed_at" | "id">,
): string {
  return `${row.listed_at}_${row.id}`;
}

/**
 * Decodes a cursor produced by `encodeJobDescriptionCursor`. Returns `null`
 * for a malformed/unparseable cursor rather than throwing — an invalid
 * cursor degrades to "no filter" (start from the newest row) instead of a
 * hard failure, which is an acceptable default for this shared, read-only
 * listing.
 */
// Both halves are validated against a strict shape before being interpolated
// into a PostgREST `.or()` filter string below — `listed_at`/`id` never
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

  const listedAt = raw.slice(0, separatorIndex);
  const id = raw.slice(separatorIndex + 1);
  if (!ISO_TIMESTAMP_PATTERN.test(listedAt) || !UUID_PATTERN.test(id)) {
    return null;
  }

  return { listedAt, id };
}

/**
 * Board filters shared by `listJobDescriptions` and `searchJobDescriptions`
 * (§7.8.6). All combine with AND; null/undefined means "no filter".
 * `location` is `"remote"` (→ `is_remote`) or one US state/DC code
 * (→ `location_states @> {code}`); a state does not include US-wide remote
 * jobs.
 */
export type JobDescriptionFilters = {
  level?: string | null;
  category?: JobCategory | null;
  location?: "remote" | UsStateCode | null;
};

/**
 * Lists job descriptions across all users (shared data), ordered by
 * `listed_at desc, id desc` ("Most recent", §7.8.1) — `id` is a secondary
 * sort key purely to make the ordering deterministic when two rows share a
 * `listed_at`, which in turn makes keyset pagination correct (see
 * `encodeJobDescriptionCursor`). Optional board filters per
 * `JobDescriptionFilters`.
 * Cursor pagination: pass the opaque cursor from the previous page's
 * `next_cursor` to fetch the next page, filtered as
 * `(listed_at, id) < (cursor.listedAt, cursor.id)` in row-value order
 * (expressed via `.or()` since supabase-js has no direct tuple-comparison
 * builder method). Fetches `limit + 1` rows so the caller can tell whether
 * another page exists without a separate count query; `hasMore` is true
 * when that extra row was found (in which case it is trimmed off `items`).
 */
export async function listJobDescriptions(
  supabase: Client,
  params: { limit?: number; cursor?: string | null } & JobDescriptionFilters,
): Promise<{ items: JobDescriptionRow[]; hasMore: boolean }> {
  const limit = Math.min(
    Math.max(1, params.limit ?? JOB_DESCRIPTIONS_DEFAULT_LIMIT),
    JOB_DESCRIPTIONS_MAX_LIMIT,
  );

  let query = supabase
    .from("job_descriptions")
    .select("*")
    .is("deleted_at", null)
    .order("listed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (params.level) {
    query = query.eq("level", params.level);
  }
  if (params.category) {
    query = query.eq("job_category", params.category);
  }
  if (params.location === "remote") {
    query = query.eq("is_remote", true);
  } else if (params.location) {
    query = query.contains("location_states", [params.location]);
  }

  if (params.cursor) {
    const decoded = decodeJobDescriptionCursor(params.cursor);
    if (decoded) {
      query = query.or(
        `listed_at.lt.${decoded.listedAt},and(listed_at.eq.${decoded.listedAt},id.lt.${decoded.id})`,
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
    /** `relevance` (default) or `recent` (`listed_at desc`), §7.8.6. */
    sort?: "relevance" | "recent";
  } & JobDescriptionFilters,
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
    category_filter: params.category || null,
    state_filter:
      params.location && params.location !== "remote" ? params.location : null,
    remote_only: params.location === "remote",
    sort_mode: params.sort ?? "relevance",
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

/** Global board-filter counts (§7.8.6). Zero-count values are absent. */
export type JobDescriptionFacets = {
  categories: Partial<Record<JobCategory, number>>;
  states: Partial<Record<UsStateCode, number>>;
  remote: number;
};

/**
 * Global counts for the board filters, via the `job_description_facets()`
 * RPC (0012). Runs over all active rows and ignores every other filter
 * (§7.8.1 decision 5: used only to hide dead-end states and mark empty
 * fields). Call with the session client: the RPC is granted to
 * `authenticated` only and is `security invoker`.
 */
export async function getJobDescriptionFacets(
  supabase: Client,
): Promise<JobDescriptionFacets> {
  const { data, error } = await supabase.rpc("job_description_facets");

  if (error) {
    throw new JobDescriptionQueryError(
      `Failed to load job description facets: ${error.message}`,
      error,
    );
  }

  const facets: JobDescriptionFacets = { categories: {}, states: {}, remote: 0 };
  for (const row of data ?? []) {
    const count = Number(row.listing_count);
    if (!Number.isFinite(count) || count <= 0) continue;
    if (row.facet === "category") {
      facets.categories[row.value as JobCategory] = count;
    } else if (row.facet === "state") {
      facets.states[row.value as UsStateCode] = count;
    } else if (row.facet === "remote") {
      facets.remote = count;
    }
  }
  return facets;
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
    /** Derived by `deriveJobFacets` (lib/jobs/facets.ts), never from the request body. */
    jobCategory: JobCategory;
    locationStates: UsStateCode[];
    isRemote: boolean;
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
      job_category: params.jobCategory,
      location_states: params.locationStates,
      is_remote: params.isRemote,
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

/**
 * Updates a job description the caller submitted, per
 * docs/ARCHITECTURE.md §10.3. Scoped to `.eq("submitted_by", submittedBy)`
 * in addition to relying on RLS (the `job_descriptions_update_own` policy
 * added by `supabase/migrations/0006_job_description_mutability.sql`) — same
 * "checked twice" ownership pattern every other query function in this
 * codebase follows (see docs/ARCHITECTURE.md §2's intro). Returns the
 * updated row, or `null` if no row matched (not found, not owned, or a
 * non-`user` (externally ingested) row — the RLS policy's `source = 'user'` check would
 * also block that last case, but the explicit filter here means the "not
 * found" `null` path is uniform regardless of which check actually stopped
 * it). Callers turn `null` into a `403`, not `404`, per §2 — existence of
 * shared job description data is already public via `GET`.
 *
 * `patch`'s nullable fields (`company`/`sourceUrl`/`location`/`level`) are
 * deliberately checked against `!== undefined`, not truthiness: `undefined`
 * means "key absent from the PATCH body, leave this column untouched" and
 * is skipped, while `null` means "clear this column back to null" and is
 * written through as a real `null`. `lib/validation/schemas.ts`'s
 * `jobDescriptionUpdateSchema` is what makes `null` reachable here at all
 * from a JSON request body (it normalizes an explicit empty string to
 * `null` before this function ever sees it) — this is the fix for a real
 * gap: without it, a submitter had no way to un-set an already-set optional
 * field via the API, only to change it to a different non-empty value.
 */
export async function updateJobDescription(
  supabase: Client,
  params: {
    id: string;
    submittedBy: string;
    patch: {
      title?: string;
      company?: string | null;
      description?: string;
      sourceUrl?: string | null;
      location?: string | null;
      level?: string | null;
      /** Recomputed by the route when `title` is in the patch (§7.8.4). */
      jobCategory?: JobCategory;
      /** Recomputed by the route when `location` is in the patch, including null. */
      locationStates?: UsStateCode[];
      isRemote?: boolean;
    };
  },
): Promise<JobDescriptionRow | null> {
  const update: Database["public"]["Tables"]["job_descriptions"]["Update"] = {};
  if (params.patch.title !== undefined) update.title = params.patch.title;
  if (params.patch.company !== undefined) update.company = params.patch.company;
  if (params.patch.description !== undefined) update.description = params.patch.description;
  if (params.patch.sourceUrl !== undefined) update.source_url = params.patch.sourceUrl;
  if (params.patch.location !== undefined) update.location = params.patch.location;
  if (params.patch.level !== undefined) update.level = params.patch.level;
  if (params.patch.jobCategory !== undefined) update.job_category = params.patch.jobCategory;
  if (params.patch.locationStates !== undefined) update.location_states = params.patch.locationStates;
  if (params.patch.isRemote !== undefined) update.is_remote = params.patch.isRemote;

  const { data, error } = await supabase
    .from("job_descriptions")
    .update(update)
    .eq("id", params.id)
    .eq("submitted_by", params.submittedBy)
    .select("*")
    .maybeSingle();

  if (error) {
    if (isInvalidInputSyntaxError(error)) {
      return null;
    }
    throw new JobDescriptionQueryError(
      `Failed to update job description ${params.id}: ${error.message}`,
      error,
    );
  }

  return data;
}

/**
 * Soft-deletes (hides) a job description the caller submitted, per
 * docs/ARCHITECTURE.md §10.1/§10.3: sets `deleted_at = now()` rather than
 * deleting the row, so `matches` referencing it (belonging to the submitter
 * or to any other user) keep resolving exactly as before. Same ownership
 * filtering as `updateJobDescription`. Returns `true`/`false` for "a row was
 * updated" — idempotent, deleting an already-deleted row still returns
 * `true` (it just re-writes the same kind of value), no special-cased
 * "already deleted" error.
 */
export async function softDeleteJobDescription(
  supabase: Client,
  params: { id: string; submittedBy: string },
): Promise<boolean> {
  const { data, error } = await supabase
    .from("job_descriptions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("submitted_by", params.submittedBy)
    .select("id")
    .maybeSingle();

  if (error) {
    if (isInvalidInputSyntaxError(error)) {
      return false;
    }
    throw new JobDescriptionQueryError(
      `Failed to soft-delete job description ${params.id}: ${error.message}`,
      error,
    );
  }

  return data !== null;
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
  /** Board facets from `deriveJobFacets` (§7.8.4), recomputed on every sync. */
  jobCategory: JobCategory;
  locationStates: UsStateCode[];
  isRemote: boolean;
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
 * Upserts a batch of externally-sourced job listings (Greenhouse/Lever
 * company boards — see `lib/jobs/sources/` and `lib/jobs/sync.ts`,
 * docs/ARCHITECTURE.md §7.7), keyed on the `(source, external_id)` unique
 * constraint added by `supabase/migrations/0004_external_job_listings.sql`.
 * Re-running a sync for a listing already ingested updates that row in place
 * (title/description/location can change between syncs) rather than creating
 * a duplicate. `submitted_by` is left `null` — these rows have no Kalify
 * user as their submitter. `deleted_at` is always written as `null`, so a
 * listing that was soft-deleted after dropping off its board (see
 * `softDeleteMissingExternalJobDescriptions`) is shown again if it
 * reappears (§7.7.6).
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
          job_category: row.jobCategory,
          location_states: row.locationStates,
          is_remote: row.isRemote,
          submitted_by: null,
          deleted_at: null,
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

/** Chunk size for the soft-delete `.in("id", ...)` filter (§7.7.6). */
const SOFT_DELETE_CHUNK_SIZE = 100;

/** Same rule as `lib/jobs/sources/companies.ts` (enforced there by a test). */
const BOARD_TOKEN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Snapshot close for one company board (docs/ARCHITECTURE.md §7.7.6):
 * soft-deletes (`deleted_at = now()`) every active row of this
 * `(source, token)` whose `external_id` is not in `presentExternalIds` —
 * the board's *unfiltered* job-id set, as `${token}:${id}` strings.
 *
 * Only call this after a complete 200 snapshot of the board and a successful
 * upsert, never after a 404, error, timeout, or skip (`lib/jobs/sync.ts`
 * enforces this). Soft delete only, never hard delete:
 * `matches.job_description_id` is `on delete cascade`.
 *
 * `token` is safe inside `LIKE` because board tokens match
 * `^[a-z0-9][a-z0-9-]*$` (no `%`/`_` wildcards); it is re-checked here as
 * defense in depth. The diff runs in JS and the update is chunked by row id,
 * so no long id list goes into a PostgREST filter URL. Callers MUST pass the
 * service-role client (`lib/supabase/admin.ts`).
 */
export async function softDeleteMissingExternalJobDescriptions(
  supabase: Client,
  source: "greenhouse" | "lever",
  token: string,
  presentExternalIds: ReadonlySet<string>,
): Promise<{ count: number }> {
  if (!BOARD_TOKEN_PATTERN.test(token)) {
    throw new JobDescriptionQueryError(
      "Refusing to soft-delete external job descriptions for an invalid board token.",
    );
  }

  const { data, error } = await supabase
    .from("job_descriptions")
    .select("id, external_id")
    .eq("source", source)
    .like("external_id", `${token}:%`)
    .is("deleted_at", null);

  if (error) {
    throw new JobDescriptionQueryError(
      `Failed to list active external job descriptions: ${error.message}`,
      error,
    );
  }

  const missingIds = (data ?? [])
    .filter(
      (row) =>
        // Defensive: `like` never matches a null external_id, so the null branch is unreachable today.
        row.external_id === null || !presentExternalIds.has(row.external_id),
    )
    .map((row) => row.id);

  if (missingIds.length === 0) {
    return { count: 0 };
  }

  const deletedAt = new Date().toISOString();
  let count = 0;
  for (const ids of chunk(missingIds, SOFT_DELETE_CHUNK_SIZE)) {
    const { error: updateError } = await supabase
      .from("job_descriptions")
      .update({ deleted_at: deletedAt })
      .in("id", ids)
      .eq("source", source)
      .is("deleted_at", null);

    if (updateError) {
      throw new JobDescriptionQueryError(
        `Failed to soft-delete external job descriptions: ${updateError.message}`,
        updateError,
      );
    }
    count += ids.length;
  }

  return { count };
}
