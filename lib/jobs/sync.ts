/**
 * Generic, adapter-driven source sync (docs/ARCHITECTURE.md §13.6.6).
 * Replaces v1's `syncThemuseJobs`. Called by the `ingest.sync_source` task
 * handler (`lib/tasks/handlers/ingest/syncSource.ts`), which owns the run
 * record and continuation tasks; this module does one task's worth of
 * paging:
 *
 *   1. Throttle to `adapter.minRequestIntervalMs`. On HTTP 429 honor
 *      `Retry-After` (≤ 60 s) once per page, then fail with retryable
 *      `source_unavailable`. Other HTTP/network failures are retryable
 *      `source_unavailable` too.
 *   2. Page until `nextCursor` is null or the elapsed time passes
 *      `SYNC_SOFT_LIMIT_MS` (180 s). In the time-out case it returns a
 *      continuation cursor; the handler enqueues the continuation task.
 *   3. Validate → student filter (board syncs only, §13.6.3) → map →
 *      upsert on `(source, external_id)` in chunks of 50
 *      (`upsertExternalJobDescriptions`). Unchanged rows still get
 *      `last_seen_at` bumped.
 *   4. `resolve_job_duplicates(touched keys)`; snapshot close (§13.6.5)
 *      when a board fetch completed.
 *
 * Idempotent per page: re-running the same cursor re-upserts the same rows
 * (same keys, same content), so a retried or duplicated continuation only
 * repeats work, never data.
 *
 * Never logs listing text: log fields are counts, slugs, board tokens and
 * HTTP statuses only (§13.15 item 7).
 */

import { computeDedupeKey } from "@/lib/jobs/normalize";
import { SourceHttpError } from "@/lib/jobs/sources/http";
import {
  SourceConfigError,
  SourceCursorError,
  type JobSourceAdapter,
  type NormalizedListing,
} from "@/lib/jobs/sources/types";
import { isStudentRelevantTitle } from "@/lib/jobs/studentFilter";
import {
  closeMissingSnapshotListings,
  upsertExternalJobDescriptions,
  type ExternalJobDescriptionUpsert,
} from "@/lib/supabase/queries/jobDescriptions";
import {
  resolveJobDuplicates,
  ZERO_RUN_COUNTS,
  type AdminClient,
  type JobSourceBoardRow,
  type JobSourceRow,
  type RunCounts,
} from "@/lib/supabase/queries/sources";
import { TaskError } from "@/lib/tasks/errors";
import type { TaskLogger } from "@/lib/tasks/types";
import {
  JOB_DESCRIPTION_COMPANY_MAX_LENGTH,
  JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_LOCATION_MAX_LENGTH,
  JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH,
  JOB_DESCRIPTION_TITLE_MAX_LENGTH,
} from "@/lib/validation/schemas";
import type { JsonObject } from "@/types/database";

/** Stop paging and continue in a new task after this much handler time (§13.6.6). */
export const SYNC_SOFT_LIMIT_MS = 180_000;
/** Longest `Retry-After` we wait for inside a task (§13.6.6). */
export const RETRY_AFTER_MAX_SECONDS = 60;
/** Wait used for a 429 without a usable `Retry-After`. */
export const RETRY_AFTER_DEFAULT_SECONDS = 30;
/** Max length kept for `external_id`. */
export const EXTERNAL_ID_MAX_LENGTH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SourceSyncInput {
  admin: AdminClient;
  adapter: JobSourceAdapter;
  source: JobSourceRow;
  /** Null for non-board (incremental) sources. */
  board: JobSourceBoardRow | null;
  /** Null = first page. */
  cursor: string | null;
  /** `job_source_runs.started_at` of the run this task belongs to. */
  runStartedAt: string;
  /** The task's abort signal (fires at its deadline). */
  signal: AbortSignal;
  /** Handler start (epoch ms); the soft limit counts from here. */
  startedAtMs: number;
  log: TaskLogger;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface SourceSyncOutcome {
  counts: RunCounts;
  pagesFetched: number;
  /** True when paging reached the end and the adapter reported a complete fetch. */
  complete: boolean;
  /** Set when this task stopped early; the handler enqueues it. */
  continuation: { cursor: string; runAfterMs: number | null } | null;
  /** Dedupe keys passed to resolve_job_duplicates. */
  touchedKeys: number;
  duplicatesChanged: number;
}

/** Abortable sleep (rejects with the signal's reason). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validIso(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A listing is stored only with an id, a title, a description and a link-back URL. */
export function isValidListing(listing: NormalizedListing): boolean {
  return (
    listing.externalId.trim().length > 0 &&
    listing.externalId.length <= EXTERNAL_ID_MAX_LENGTH &&
    listing.title.trim().length > 0 &&
    listing.descriptionText.trim().length > 0 &&
    isHttpUrl(listing.sourceUrl)
  );
}

/**
 * `expires_at = coalesce(sourceExpiresAt, greatest(postedAt, last_seen_at)
 * + job_sources.default_ttl_days)` (§13.6.5).
 */
export function computeExpiresAt(
  listing: Pick<NormalizedListing, "postedAt" | "sourceExpiresAt">,
  lastSeenAtMs: number,
  ttlDays: number,
): string {
  const sourceExpires = validIso(listing.sourceExpiresAt);
  if (sourceExpires) return sourceExpires;
  const posted = validIso(listing.postedAt);
  const base = Math.max(posted ? Date.parse(posted) : lastSeenAtMs, lastSeenAtMs);
  return new Date(base + ttlDays * DAY_MS).toISOString();
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Maps a validated listing to the upsert row (caps lengths; board company fallback). */
export function toExternalUpsert(
  listing: NormalizedListing,
  args: { source: JobSourceRow; board: JobSourceBoardRow | null; nowMs: number },
): ExternalJobDescriptionUpsert {
  // Greenhouse/Lever: the company comes from job_source_boards.company_name (§13.6.2).
  const company =
    (listing.company?.trim() || args.board?.company_name?.trim() || null)?.slice(0, JOB_DESCRIPTION_COMPANY_MAX_LENGTH) ?? null;
  const title = listing.title.trim().slice(0, JOB_DESCRIPTION_TITLE_MAX_LENGTH);
  const applyUrl = listing.applyUrl && isHttpUrl(listing.applyUrl) ? listing.applyUrl : null;
  const currency = listing.salary?.currency?.trim().toUpperCase() ?? null;
  const country = listing.locationCountry?.trim().toUpperCase() ?? null;

  return {
    externalId: listing.externalId.trim(),
    title,
    company,
    description: listing.descriptionText.trim().slice(0, JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH),
    sourceUrl: listing.sourceUrl,
    applyUrl,
    level: listing.levelRaw?.trim().slice(0, 100) || null,
    location: listing.locationText?.trim().slice(0, JOB_DESCRIPTION_LOCATION_MAX_LENGTH) || null,
    postedAt: validIso(listing.postedAt),
    sourceBoard: listing.sourceBoard ?? args.board?.board_token ?? null,
    employmentType: listing.employmentType?.trim().slice(0, 100) || null,
    remoteType: listing.remoteType,
    locationCountry: country && /^[A-Z]{2}$/.test(country) ? country : null,
    salaryMin: finiteOrNull(listing.salary?.min),
    salaryMax: finiteOrNull(listing.salary?.max),
    salaryCurrency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    salaryPeriod: listing.salary?.period ?? null,
    lastSeenAt: new Date(args.nowMs).toISOString(),
    expiresAt: computeExpiresAt(listing, args.nowMs, args.source.default_ttl_days),
    dedupeKey: computeDedupeKey({
      company,
      title,
      remoteType: listing.remoteType,
      primaryLocation: listing.primaryLocation,
    }),
    sourceMetadata: listing.sourceMetadata as JsonObject,
  };
}

/**
 * Runs one task's share of a source/board sync. Throws `TaskError` for
 * source failures; lets the task deadline's abort propagate.
 */
export async function runSourceSync(input: SourceSyncInput): Promise<SourceSyncOutcome> {
  const { admin, adapter, source, board, signal, log } = input;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? abortableSleep;

  const counts: RunCounts = { ...ZERO_RUN_COUNTS };
  const touched = new Set<string>();
  let cursor = input.cursor;
  let pagesFetched = 0;
  let complete = false;
  let continuation: SourceSyncOutcome["continuation"] = null;
  let lastRequestAt: number | null = null;

  const elapsed = () => now() - input.startedAtMs;

  for (;;) {
    if (elapsed() >= SYNC_SOFT_LIMIT_MS) {
      // Only reachable with a non-null cursor: the first page always runs.
      continuation = { cursor: cursor as string, runAfterMs: null };
      break;
    }

    let page;
    let retriedRateLimit = false;
    for (;;) {
      if (lastRequestAt !== null) {
        const wait = lastRequestAt + adapter.minRequestIntervalMs - now();
        if (wait > 0) await sleep(wait, signal);
      }
      lastRequestAt = now();
      try {
        page = await adapter.fetchPage({ board: board?.board_token ?? null, cursor, config: source.config, signal });
        break;
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof SourceHttpError && err.status === 429) {
          if (retriedRateLimit) {
            throw new TaskError("source_unavailable", `${source.slug} rate-limited the sync (HTTP 429) twice.`, { cause: err });
          }
          retriedRateLimit = true;
          const waitSeconds = Math.min(err.retryAfterSeconds ?? RETRY_AFTER_DEFAULT_SECONDS, RETRY_AFTER_MAX_SECONDS);
          if (elapsed() + waitSeconds * 1000 >= SYNC_SOFT_LIMIT_MS && cursor !== null) {
            // Waiting would run past the soft limit: continue later instead.
            continuation = { cursor, runAfterMs: now() + waitSeconds * 1000 };
            break;
          }
          log.warn("source rate-limited; honoring Retry-After once", { source: source.slug, wait_s: waitSeconds });
          await sleep(waitSeconds * 1000, signal);
          continue;
        }
        if (err instanceof SourceHttpError) {
          throw new TaskError("source_unavailable", err.message, { cause: err });
        }
        if (err instanceof SourceCursorError) {
          throw new TaskError("unknown_payload", err.message, { retryable: false, cause: err });
        }
        if (err instanceof SourceConfigError) {
          throw new TaskError("internal_error", err.message, { retryable: false, cause: err });
        }
        throw err;
      }
    }
    if (continuation) break;
    if (!page) throw new TaskError("internal_error", "Adapter returned no page.");

    pagesFetched++;
    counts.fetched += page.listings.length;

    const rows: ExternalJobDescriptionUpsert[] = [];
    const nowMs = now();
    for (const listing of page.listings) {
      if (!isValidListing(listing)) {
        counts.skipped_invalid++;
        continue;
      }
      if (board && !isStudentRelevantTitle(listing.title, { includeUnlabeledTitles: board.include_unlabeled_titles })) {
        counts.skipped_filtered++;
        continue;
      }
      rows.push(toExternalUpsert(listing, { source, board, nowMs }));
    }

    if (rows.length > 0) {
      const result = await upsertExternalJobDescriptions(admin, source.slug, rows, { signal });
      counts.inserted += result.inserted;
      counts.updated += result.updated;
      counts.unchanged += result.unchanged;
      for (const row of rows) if (row.dedupeKey) touched.add(row.dedupeKey);
      for (const key of result.previousDedupeKeys) touched.add(key);
    }

    if (page.nextCursor === null) {
      complete = page.complete;
      break;
    }
    cursor = page.nextCursor;
  }

  // Snapshot close only after a complete, error-free board fetch (§13.6.5).
  // Any fetch error above threw, so reaching here with `complete` means
  // every page of this run was fetched.
  if (complete && board && source.sync_mode === "snapshot") {
    const closedResult = await closeMissingSnapshotListings(admin, {
      source: source.slug,
      sourceBoard: board.board_token,
      runStartedAt: input.runStartedAt,
      signal,
    });
    counts.closed += closedResult.closed;
    for (const key of closedResult.dedupeKeys) touched.add(key);
  }

  const duplicatesChanged = touched.size > 0 ? await resolveJobDuplicates(admin, touched, { signal }) : 0;

  log.info("source sync pass finished", {
    source: source.slug,
    board: board?.board_token ?? null,
    pages: pagesFetched,
    fetched: counts.fetched,
    inserted: counts.inserted,
    updated: counts.updated,
    unchanged: counts.unchanged,
    skipped_filtered: counts.skipped_filtered,
    skipped_invalid: counts.skipped_invalid,
    closed: counts.closed,
    continued: continuation !== null,
  });

  return { counts, pagesFetched, complete, continuation, touchedKeys: touched.size, duplicatesChanged };
}
