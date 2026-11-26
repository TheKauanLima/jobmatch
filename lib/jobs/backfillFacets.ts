/**
 * Facet backfill (docs/ARCHITECTURE.md §7.8.4), run by the daily sync cron
 * (`app/api/cron/sync-jobs/route.ts`) after `syncExternalJobs`. Fills
 * `job_category`, `location_states`, and `is_remote` on rows where
 * `job_category is null` (user rows, legacy The Muse rows, soft-deleted
 * rows, and anything written before migration 0012). External rows still on
 * a board are recomputed by the sync itself, with their department.
 *
 * Derives from title + location only (no department is stored). Updates
 * each row by id with a small pool, and stops starting new updates once
 * `deadlineMs` (epoch ms) has passed. Callers MUST pass the service-role
 * client: user rows belong to other users, so RLS would block the update.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";
import { deriveJobFacets } from "@/lib/jobs/facets";

type Client = SupabaseClient<Database>;

export const FACET_BACKFILL_DEFAULT_LIMIT = 200;
export const FACET_BACKFILL_CONCURRENCY = 4;

export class FacetBackfillError extends Error {
  constructor(
    message: string,
    /** Rows updated before/despite the failure. */
    readonly updated = 0,
  ) {
    super(message);
    this.name = "FacetBackfillError";
  }
}

export type FacetBackfillResult = {
  updated: number;
  /**
   * True when the run filled `limit` rows (more may be waiting), or when the
   * deadline stopped it before every selected row was updated.
   */
  remaining: boolean;
};

export async function backfillJobFacets(
  admin: Client,
  opts: { limit?: number; deadlineMs: number; now?: () => number },
): Promise<FacetBackfillResult> {
  const limit = opts.limit ?? FACET_BACKFILL_DEFAULT_LIMIT;
  const now = opts.now ?? Date.now;

  if (now() >= opts.deadlineMs) {
    return { updated: 0, remaining: true };
  }

  const { data, error } = await admin
    .from("job_descriptions")
    .select("id, title, location")
    .is("job_category", null)
    .order("id", { ascending: true })
    .limit(limit);

  if (error) {
    throw new FacetBackfillError(`Failed to list rows without facets: ${error.message}`);
  }

  const rows = data ?? [];
  let updated = 0;
  let failed = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < rows.length) {
      if (now() >= opts.deadlineMs) return;
      const row = rows[next++];
      const facets = deriveJobFacets({ title: row.title, location: row.location });
      const { error: updateError } = await admin
        .from("job_descriptions")
        .update({
          job_category: facets.jobCategory,
          location_states: facets.locationStates,
          is_remote: facets.isRemote,
        })
        .eq("id", row.id);
      if (updateError) {
        failed++;
        // Name and message only: never row content.
        console.error("backfillJobFacets: update failed:", updateError.message);
      } else {
        updated++;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(FACET_BACKFILL_CONCURRENCY, rows.length) }, worker),
  );

  if (failed > 0) {
    throw new FacetBackfillError(
      `${failed} facet update(s) failed (${updated} succeeded).`,
      updated,
    );
  }

  return { updated, remaining: updated >= limit || next < rows.length };
}
