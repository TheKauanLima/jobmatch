/**
 * Orchestrates a full external-job-listing sync: paginate The Muse's public
 * Jobs API across the levels in `THEMUSE_SYNC_LEVELS`, map each result, and
 * upsert into `job_descriptions`. See docs/ARCHITECTURE.md §7 for why this
 * exists (solving the cold-start problem: a brand-new user shouldn't see an
 * empty job board) and why The Muse specifically.
 *
 * Invoked by `app/api/cron/sync-jobs/route.ts` (see that file for the
 * trigger/auth mechanism — Vercel Cron or any external scheduler hitting the
 * route with a shared secret).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";
import {
  fetchThemuseJobsPage,
  mapThemuseJobToExternalJobDescription,
  THEMUSE_SYNC_LEVELS,
  ThemuseApiError,
} from "@/lib/jobs/themuse";
import {
  upsertExternalJobDescriptions,
  type ExternalJobDescriptionUpsert,
} from "@/lib/supabase/queries/jobDescriptions";

type Client = SupabaseClient<Database>;

/**
 * Pages fetched per level per run. 20 results/page * 5 pages * 2 levels =
 * up to 200 listings/run, comfortably inside The Muse's unauthenticated rate
 * limit (500 req/hour — this run makes at most 10 requests) and small enough
 * that a daily cron (see `vercel.json`) builds up a substantial, continually
 * refreshed board over its first couple of weeks without ever hammering the
 * source API. Increase later if the board's growth rate needs to be faster
 * than that — not a value worth exposing as an env var for v1.
 */
const MAX_PAGES_PER_LEVEL = 5;

export type SyncLevelResult = {
  level: string;
  fetched: number;
  mapped: number;
  skippedInvalid: number;
  pagesFetched: number;
  error: string | null;
};

export type SyncThemuseJobsResult = {
  levels: SyncLevelResult[];
  totalUpserted: number;
};

/**
 * Runs one sync pass across all of `THEMUSE_SYNC_LEVELS`. `supabase` must be
 * a service-role client (see `lib/supabase/admin.ts`) — the upsert writes
 * rows with no `submitted_by`, which the normal per-user RLS insert policy
 * would reject.
 *
 * Resilient by design: a failure fetching one page (network error, a
 * non-2xx response, The Muse API being down) stops pagination for that
 * *level* only and is recorded in that level's `error` field — it does not
 * abort the other level's sync, and levels already fetched are still
 * upserted. A cron job that runs daily should self-heal from a transient
 * failure on the next run rather than needing manual intervention, so this
 * favors "make partial progress and report what happened" over "all or
 * nothing".
 */
export async function syncThemuseJobs(
  supabase: Client,
): Promise<SyncThemuseJobsResult> {
  const levelResults: SyncLevelResult[] = [];
  let totalUpserted = 0;

  for (const level of THEMUSE_SYNC_LEVELS) {
    const mappedRows: ExternalJobDescriptionUpsert[] = [];
    let fetched = 0;
    let skippedInvalid = 0;
    let pagesFetched = 0;
    let error: string | null = null;

    for (let page = 0; page < MAX_PAGES_PER_LEVEL; page++) {
      try {
        const { results, pageCount } = await fetchThemuseJobsPage(
          level,
          page,
        );
        pagesFetched++;
        fetched += results.length;

        for (const raw of results) {
          const mapped = mapThemuseJobToExternalJobDescription(raw);
          if (mapped) {
            mappedRows.push(mapped);
          } else {
            skippedInvalid++;
          }
        }

        if (page + 1 >= pageCount) {
          break;
        }
      } catch (err) {
        error =
          err instanceof ThemuseApiError
            ? err.message
            : "Unknown error fetching The Muse jobs.";
        break;
      }
    }

    let upserted = 0;
    if (mappedRows.length > 0) {
      try {
        const result = await upsertExternalJobDescriptions(
          supabase,
          "themuse",
          mappedRows,
        );
        upserted = result.count;
      } catch (err) {
        error = err instanceof Error ? err.message : "Unknown upsert error.";
      }
    }

    totalUpserted += upserted;
    levelResults.push({
      level,
      fetched,
      mapped: mappedRows.length,
      skippedInvalid,
      pagesFetched,
      error,
    });
  }

  return { levels: levelResults, totalUpserted };
}
