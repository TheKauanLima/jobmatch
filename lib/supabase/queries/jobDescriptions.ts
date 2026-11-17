/**
 * Postgres access for the `job_descriptions` table (docs/ARCHITECTURE.md §3,
 * §13.3.3, §13.13.4).
 *
 * Reads go through the caller's session client, so RLS
 * (`job_descriptions_select_visible`: shared rows, plus the caller's own
 * private rows) decides what exists. Listing and search add the scope on
 * top: `shared` = active shared listings only, `mine` = everything the
 * caller submitted except hidden duplicates.
 *
 * Writes by users go through the security-definer RPCs from 0009
 * (`create_job_listing`, `update_job_listing`, `delete_job_listing`):
 * direct INSERT/UPDATE/DELETE is revoked from `authenticated`. Their errors
 * are classified into `JobListingRpcError.reason` for the routes.
 *
 * The ingestion helpers at the bottom (`upsertExternalJobDescriptions`,
 * `closeMissingSnapshotListings`, the backfill helpers) take the
 * **service-role** client: they're called only from `lib/jobs/**` and
 * `lib/tasks/**`.
 *
 * Returns full DB rows; route handlers shape them with `types/domain.ts`.
 * Error messages carry the operation plus PostgREST's message, never row
 * content.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  Database,
  JobDescriptionSource,
  JobListingVisibility,
  JobRemoteType,
  JobSalaryPeriod,
  JsonObject,
  RateLimitKind,
} from "@/types/database";
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
 * query-param bound, validated inline in the route like `?limit=`.
 */
export const JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH = 200;

/** `?scope=` values for `GET /api/job-descriptions` (§13.13.4). */
export const JOB_DESCRIPTION_SCOPES = ["shared", "mine"] as const;
export type JobDescriptionScope = (typeof JOB_DESCRIPTION_SCOPES)[number];

export function isJobDescriptionScope(value: string): value is JobDescriptionScope {
  return (JOB_DESCRIPTION_SCOPES as readonly string[]).includes(value);
}

/**
 * A decoded pagination cursor: the `(created_at, id)` position of the last
 * row returned on the previous page.
 */
export type JobDescriptionCursor = { createdAt: string; id: string };

/**
 * Encodes a `(created_at, id)` pair into the opaque cursor string returned
 * as `next_cursor` (per docs/ARCHITECTURE.md §2). `id` is the tiebreaker
 * for rows with an identical `created_at`. Joining with `_` is safe because
 * neither an ISO-8601 timestamp nor a uuid can contain that character.
 */
export function encodeJobDescriptionCursor(
  row: Pick<JobDescriptionRow, "created_at" | "id">,
): string {
  return `${row.created_at}_${row.id}`;
}

// Both halves are validated against a strict shape before being interpolated
// into a PostgREST `.or()` filter string below: the cursor is a
// client-supplied query param, so filter-syntax characters must never reach
// that string unchecked.
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decodes a cursor produced by `encodeJobDescriptionCursor`. Returns `null`
 * for a malformed cursor rather than throwing: it degrades to "first page".
 */
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
 * Keyset listing ordered `created_at desc, id desc` (`id` makes the order
 * deterministic for tied timestamps, which keeps pagination correct).
 * Fetches `limit + 1` rows so the caller can tell whether another page
 * exists; `hasMore` is true when that extra row was found (it is trimmed).
 *
 * Scopes (§13.13.4):
 * - `shared` (default): `visibility = 'shared'` plus the active predicate
 *   (`deleted_at`, `closed_at`, `duplicate_of` all null). Excludes every
 *   private row, including the caller's own.
 * - `mine`: `submitted_by = callerId`, shared and private, closed and
 *   soft-deleted included; only hidden duplicates are excluded. `callerId`
 *   must be the session user's id (never request input); RLS still applies.
 */
export async function listJobDescriptions(
  supabase: Client,
  params: {
    limit?: number;
    cursor?: string | null;
    level?: string | null;
    scope?: JobDescriptionScope;
    callerId?: string;
  },
): Promise<{ items: JobDescriptionRow[]; hasMore: boolean }> {
  const limit = Math.min(
    Math.max(1, params.limit ?? JOB_DESCRIPTIONS_DEFAULT_LIMIT),
    JOB_DESCRIPTIONS_MAX_LIMIT,
  );
  const scope = params.scope ?? "shared";

  let query = supabase
    .from("job_descriptions")
    .select("*")
    .is("duplicate_of", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (scope === "mine") {
    if (!params.callerId) {
      throw new JobDescriptionQueryError("listJobDescriptions: scope 'mine' requires callerId.");
    }
    query = query.eq("submitted_by", params.callerId);
  } else {
    query = query
      .eq("visibility", "shared")
      .is("deleted_at", null)
      .is("closed_at", null);
  }

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
 * docs/ARCHITECTURE.md §9.2. A distinct shape from the keyset cursor so a
 * cursor from one mode fails the other mode's decode.
 */
export function encodeJobDescriptionOffsetCursor(offset: number): string {
  return `offset_${offset}`;
}

const OFFSET_CURSOR_PATTERN = /^offset_(\d+)$/;

/** Decodes an offset cursor; `null` (first page) when malformed. */
export function decodeJobDescriptionOffsetCursor(raw: string): number | null {
  const match = OFFSET_CURSOR_PATTERN.exec(raw);
  if (!match) {
    return null;
  }

  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) ? offset : null;
}

/**
 * Ranked full-text search via `search_job_descriptions` v2 (0009), with the
 * same scopes as `listJobDescriptions` (the function applies them in SQL;
 * `mine` resolves the caller from `auth.uid()`). Offset pagination
 * (§9.2); fetches `limit + 1` rows for `hasMore`.
 */
export async function searchJobDescriptions(
  supabase: Client,
  params: {
    query: string;
    limit?: number;
    offset?: number;
    level?: string | null;
    scope?: JobDescriptionScope;
  },
): Promise<{ items: JobDescriptionRow[]; hasMore: boolean }> {
  const limit = Math.min(
    Math.max(1, params.limit ?? JOB_DESCRIPTIONS_DEFAULT_LIMIT),
    JOB_DESCRIPTIONS_MAX_LIMIT,
  );
  const offset = Math.max(0, params.offset ?? 0);

  const { data, error } = await supabase.rpc("search_job_descriptions", {
    search_query: params.query,
    // `||`, not `??`: an empty `?level=` means "no filter" (§2/§9.3), and
    // `level = ''` would match nothing.
    level_filter: params.level || null,
    scope: params.scope ?? "shared",
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
 * Fetches a single job description by id through RLS: another user's
 * private listing returns `null`, exactly like a missing row (§13.13.4 →
 * 404). Closed, duplicate and soft-deleted rows still resolve. A malformed
 * (non-uuid) `id` also returns `null` (see `lib/supabase/postgresErrors.ts`).
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
 * Batch-fetches job descriptions by id (used by
 * `lib/supabase/queries/matches.ts` to join titles onto matches without an
 * N+1). RLS applies. Returns `[]` for an empty `ids` array.
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

// ---------------------------------------------------------------------
// Listing RPCs (session client; 0009)
// ---------------------------------------------------------------------

/**
 * Why a listing RPC failed, classified from the §13.13 RPC error format:
 * - `rate_limited` — `rate_limited:<kind>` → 429
 * - `not_found` — `not_found_or_not_owner` (a race past the route's
 *   pre-check) → 404/403 per the route
 * - `visibility_downgrade` — shared → private → 400
 * - `validation` — `validation_*` → 400
 * - `unauthenticated` — SQLSTATE 42501 (no `auth.uid()`) → 401
 * - `internal` — anything else → 500
 */
export type JobListingRpcFailure =
  | "rate_limited"
  | "not_found"
  | "visibility_downgrade"
  | "validation"
  | "unauthenticated"
  | "internal";

export class JobListingRpcError extends Error {
  readonly reason: JobListingRpcFailure;
  /** For `rate_limited`: the limit kind from the message. */
  readonly rateLimitKind: RateLimitKind | null;
  /** For `validation`: the machine code, e.g. `validation_title`. */
  readonly validationCode: string | null;

  constructor(
    operation: string,
    error: { code?: string | null; message?: string | null },
  ) {
    const message = (error.message ?? "").trim();
    super(`${operation} failed${error.code ? ` (${error.code})` : ""}: ${message.slice(0, 200) || "unknown error"}`);
    this.name = "JobListingRpcError";

    const rateLimited = /^rate_limited:([a-z_]+)$/.exec(message);
    const validation = /^validation_[a-z_]+$/.exec(message);
    this.rateLimitKind = rateLimited ? (rateLimited[1] as RateLimitKind) : null;
    this.validationCode = validation ? validation[0] : null;

    if (error.code === "42501") this.reason = "unauthenticated";
    else if (rateLimited) this.reason = "rate_limited";
    else if (message.startsWith("not_found")) this.reason = "not_found";
    else if (message === "visibility_downgrade") this.reason = "visibility_downgrade";
    else if (validation) this.reason = "validation";
    else this.reason = "internal";
  }
}

/** `create_job_listing`: submits as `auth.uid()`; consumes `job_listing_create`. */
export async function createJobListing(
  supabase: Client,
  params: {
    title: string;
    company?: string | null;
    description: string;
    sourceUrl?: string | null;
    location?: string | null;
    level?: string | null;
    visibility: JobListingVisibility;
  },
): Promise<JobDescriptionRow> {
  const { data, error } = await supabase.rpc("create_job_listing", {
    p_title: params.title,
    p_company: params.company ?? null,
    p_description: params.description,
    p_source_url: params.sourceUrl ?? null,
    p_location: params.location ?? null,
    p_level: params.level ?? null,
    p_visibility: params.visibility,
  });

  if (error) throw new JobListingRpcError("create_job_listing", error);
  if (!data || typeof data !== "object") {
    throw new JobListingRpcError("create_job_listing", { message: "no row returned" });
  }
  return data;
}

export type JobListingPatch = {
  title?: string;
  company?: string | null;
  description?: string;
  sourceUrl?: string | null;
  location?: string | null;
  level?: string | null;
  visibility?: JobListingVisibility;
};

/**
 * `update_job_listing`. Keys absent from `patch` (`undefined`) are left
 * out of `p_patch` and untouched; an explicit `null` clears a nullable
 * column. Consumes `job_listing_update` only when the content changes.
 */
export async function updateJobListing(
  supabase: Client,
  params: { id: string; patch: JobListingPatch },
): Promise<JobDescriptionRow> {
  const patch: Record<string, string | null> = {};
  const { title, company, description, sourceUrl, location, level, visibility } = params.patch;
  if (title !== undefined) patch.title = title;
  if (company !== undefined) patch.company = company;
  if (description !== undefined) patch.description = description;
  if (sourceUrl !== undefined) patch.source_url = sourceUrl;
  if (location !== undefined) patch.location = location;
  if (level !== undefined) patch.level = level;
  if (visibility !== undefined) patch.visibility = visibility;

  const { data, error } = await supabase.rpc("update_job_listing", {
    p_id: params.id,
    p_patch: patch,
  });

  if (error) throw new JobListingRpcError("update_job_listing", error);
  if (!data || typeof data !== "object") {
    throw new JobListingRpcError("update_job_listing", { message: "no row returned" });
  }
  return data;
}

/** `delete_job_listing`: private → hard delete, shared → soft delete. */
export async function deleteJobListing(
  supabase: Client,
  id: string,
): Promise<"deleted" | "soft_deleted"> {
  const { data, error } = await supabase.rpc("delete_job_listing", { p_id: id });

  if (error) throw new JobListingRpcError("delete_job_listing", error);
  if (data !== "deleted" && data !== "soft_deleted") {
    throw new JobListingRpcError("delete_job_listing", { message: "unexpected result" });
  }
  return data;
}

// ---------------------------------------------------------------------
// Ingestion (service-role client only)
// ---------------------------------------------------------------------

/** One externally-sourced listing, mapped and ready to upsert (see `lib/jobs/sync.ts`). */
export type ExternalJobDescriptionUpsert = {
  externalId: string;
  title: string;
  company: string | null;
  description: string;
  sourceUrl: string;
  applyUrl: string | null;
  level: string | null;
  location: string | null;
  postedAt: string | null;
  sourceBoard: string | null;
  employmentType: string | null;
  remoteType: JobRemoteType | null;
  locationCountry: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: JobSalaryPeriod | null;
  lastSeenAt: string;
  expiresAt: string | null;
  dedupeKey: string | null;
  sourceMetadata: JsonObject;
};

export type ExternalUpsertResult = {
  /** Rows written (inserted + updated + unchanged). */
  count: number;
  inserted: number;
  /** Existing rows whose title/company/description changed. */
  updated: number;
  /** Existing rows with the same content (still get last_seen_at etc. bumped). */
  unchanged: number;
  /** Rows reopened because they had been closed as removed_at_source (§13.6.5). */
  reopened: number;
  /**
   * Dedupe keys existing rows had before this upsert changed them (e.g. a
   * retitled listing). Those key groups must be re-resolved too, or their
   * other rows would keep pointing at a row that no longer shares the key.
   */
  previousDedupeKeys: string[];
};

/** Batch size for `upsertExternalJobDescriptions` (§13.6.6: chunks of 50). */
export const EXTERNAL_UPSERT_BATCH_SIZE = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

type ExistingExternalRow = Pick<
  JobDescriptionRow,
  "external_id" | "title" | "company" | "description" | "closed_reason" | "dedupe_key"
>;

/**
 * Upserts externally-sourced listings on the `(source, external_id)` unique
 * constraint (0004), in chunks of 50 (§13.6.6). Every row gets the given
 * `lastSeenAt`, so unchanged rows are still marked as seen.
 *
 * Per chunk it first reads the existing rows' content and `closed_reason`
 * so it can (a) report inserted / updated / unchanged counts for
 * `job_source_runs` and (b) reopen rows closed as `removed_at_source`
 * (§13.6.5). The reopen rows are written in a separate request that
 * includes `closed_at`/`closed_reason = null`; every other row is written
 * without those columns, so the upsert never reopens a row closed for any
 * other reason (expired, manual) and never races the expiry sweep.
 * `visibility`, `submitted_by`, `owner_user_id`, `deleted_at` and
 * `duplicate_of` are never written here (new rows get the defaults:
 * shared, no owner); `content_hash` is set by its trigger.
 *
 * Duplicate external ids within one call are collapsed (last one wins),
 * because Postgres rejects an upsert that touches the same row twice.
 *
 * Callers MUST pass the service-role client (direct writes are revoked from
 * `authenticated`).
 */
export async function upsertExternalJobDescriptions(
  supabase: Client,
  source: Exclude<JobDescriptionSource, "user">,
  rows: ExternalJobDescriptionUpsert[],
  options: { signal?: AbortSignal } = {},
): Promise<ExternalUpsertResult> {
  const result: ExternalUpsertResult = {
    count: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    reopened: 0,
    previousDedupeKeys: [],
  };
  if (rows.length === 0) return result;

  const unique = [...new Map(rows.map((row) => [row.externalId, row])).values()];

  for (const batch of chunk(unique, EXTERNAL_UPSERT_BATCH_SIZE)) {
    let existingQuery = supabase
      .from("job_descriptions")
      .select("external_id, title, company, description, closed_reason, dedupe_key")
      .eq("source", source)
      .in(
        "external_id",
        batch.map((row) => row.externalId),
      );
    if (options.signal) existingQuery = existingQuery.abortSignal(options.signal);
    const { data: existingData, error: existingError } = await existingQuery;
    if (existingError) {
      throw new JobDescriptionQueryError(
        `Failed to read existing external job descriptions: ${existingError.message}`,
        existingError,
      );
    }

    const existing = new Map<string, ExistingExternalRow>(
      ((existingData ?? []) as ExistingExternalRow[])
        .filter((row) => row.external_id !== null)
        .map((row) => [row.external_id as string, row]),
    );

    const normal: Database["public"]["Tables"]["job_descriptions"]["Insert"][] = [];
    const reopen: Database["public"]["Tables"]["job_descriptions"]["Insert"][] = [];

    for (const row of batch) {
      const values = toInsertValues(source, row);
      const prior = existing.get(row.externalId);
      if (!prior) {
        result.inserted++;
      } else if (prior.title === row.title && prior.company === row.company && prior.description === row.description) {
        result.unchanged++;
      } else {
        result.updated++;
      }

      if (prior?.dedupe_key && prior.dedupe_key !== row.dedupeKey) {
        result.previousDedupeKeys.push(prior.dedupe_key);
      }

      if (prior?.closed_reason === "removed_at_source") {
        reopen.push({ ...values, closed_at: null, closed_reason: null });
        result.reopened++;
      } else {
        normal.push(values);
      }
    }

    for (const group of [normal, reopen]) {
      if (group.length === 0) continue;
      let upsert = supabase
        .from("job_descriptions")
        .upsert(group, { onConflict: "source,external_id" });
      if (options.signal) upsert = upsert.abortSignal(options.signal);
      const { error } = await upsert;
      if (error) {
        throw new JobDescriptionQueryError(
          `Failed to upsert external job descriptions: ${error.message}`,
          error,
        );
      }
    }

    result.count += batch.length;
  }

  return result;
}

function toInsertValues(
  source: Exclude<JobDescriptionSource, "user">,
  row: ExternalJobDescriptionUpsert,
): Database["public"]["Tables"]["job_descriptions"]["Insert"] {
  // Every row in a request carries the same keys: PostgREST builds one
  // column list per request.
  return {
    source,
    external_id: row.externalId,
    submitted_by: null,
    title: row.title,
    company: row.company,
    description: row.description,
    source_url: row.sourceUrl,
    apply_url: row.applyUrl,
    level: row.level,
    location: row.location,
    posted_at: row.postedAt,
    source_board: row.sourceBoard,
    employment_type: row.employmentType,
    remote_type: row.remoteType,
    location_country: row.locationCountry,
    salary_min: row.salaryMin,
    salary_max: row.salaryMax,
    salary_currency: row.salaryCurrency,
    salary_period: row.salaryPeriod,
    last_seen_at: row.lastSeenAt,
    expires_at: row.expiresAt,
    dedupe_key: row.dedupeKey,
    source_metadata: row.sourceMetadata,
  };
}

/**
 * Snapshot close (§13.6.5): after a COMPLETE, error-free board fetch, close
 * the board's open rows not seen since the run started
 * (`closed_reason = 'removed_at_source'`). Never call it after a partial or
 * failed fetch. Returns the closed rows' dedupe keys (for
 * `resolve_job_duplicates`) and count.
 */
export async function closeMissingSnapshotListings(
  supabase: Client,
  params: {
    source: Exclude<JobDescriptionSource, "user">;
    sourceBoard: string;
    runStartedAt: string;
    signal?: AbortSignal;
  },
): Promise<{ closed: number; dedupeKeys: string[] }> {
  let query = supabase
    .from("job_descriptions")
    .update({ closed_at: new Date().toISOString(), closed_reason: "removed_at_source" })
    .eq("source", params.source)
    .eq("source_board", params.sourceBoard)
    .is("closed_at", null)
    .lt("last_seen_at", params.runStartedAt)
    .select("dedupe_key");
  if (params.signal) query = query.abortSignal(params.signal);
  const { data, error } = await query;

  if (error) {
    throw new JobDescriptionQueryError(
      `Failed to close removed snapshot listings: ${error.message}`,
      error,
    );
  }
  const rows = (data ?? []) as Pick<JobDescriptionRow, "dedupe_key">[];
  return {
    closed: rows.length,
    dedupeKeys: rows.map((row) => row.dedupe_key).filter((key): key is string => key !== null),
  };
}

/** Columns `maintenance.backfill_job_keys` reads. */
export type JobKeyBackfillRow = Pick<
  JobDescriptionRow,
  | "id"
  | "source"
  | "title"
  | "company"
  | "location"
  | "posted_at"
  | "created_at"
  | "updated_at"
  | "last_seen_at"
  | "expires_at"
  | "dedupe_key"
>;

/**
 * External rows still missing `last_seen_at` or `expires_at` (i.e. ingested
 * before 0009 and not re-synced since), in id order after `afterId`.
 */
export async function listJobsNeedingKeyBackfill(
  supabase: Client,
  params: { afterId: string | null; limit: number; signal?: AbortSignal },
): Promise<JobKeyBackfillRow[]> {
  let query = supabase
    .from("job_descriptions")
    .select("id, source, title, company, location, posted_at, created_at, updated_at, last_seen_at, expires_at, dedupe_key")
    .neq("source", "user")
    .or("last_seen_at.is.null,expires_at.is.null")
    .order("id", { ascending: true })
    .limit(params.limit);
  if (params.afterId) query = query.gt("id", params.afterId);
  if (params.signal) query = query.abortSignal(params.signal);

  const { data, error } = await query;
  if (error) {
    throw new JobDescriptionQueryError(
      `Failed to list job descriptions for key backfill: ${error.message}`,
      error,
    );
  }
  return (data ?? []) as JobKeyBackfillRow[];
}

/**
 * Writes the backfilled keys for one row. Only fills columns that are still
 * null (`.is(..., null)` guards would need one request per column, so the
 * caller passes the existing value through when it is already set).
 */
export async function updateJobKeys(
  supabase: Client,
  params: {
    id: string;
    dedupeKey: string | null;
    lastSeenAt: string;
    expiresAt: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  let query = supabase
    .from("job_descriptions")
    .update({
      dedupe_key: params.dedupeKey,
      last_seen_at: params.lastSeenAt,
      expires_at: params.expiresAt,
    })
    .eq("id", params.id)
    .neq("source", "user");
  if (params.signal) query = query.abortSignal(params.signal);

  const { error } = await query;
  if (error) {
    throw new JobDescriptionQueryError(
      `Failed to backfill keys for job description ${params.id}: ${error.message}`,
      error,
    );
  }
}
