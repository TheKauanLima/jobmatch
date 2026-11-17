import { z } from "zod";

import { computeDedupeKey } from "@/lib/jobs/normalize";
import { themuseLocationFromText } from "@/lib/jobs/sources/themuse";
import {
  listJobsNeedingKeyBackfill,
  updateJobKeys,
  type JobKeyBackfillRow,
} from "@/lib/supabase/queries/jobDescriptions";
import { resolveJobDuplicates } from "@/lib/supabase/queries/sources";
import type { TaskContext, TaskHandlerResult } from "@/lib/tasks/types";

/**
 * `maintenance.backfill_job_keys` (docs/ARCHITECTURE.md §13.3.3, §13.4.3):
 * one-time backfill for external rows ingested before 0009. Run once after
 * 0009 is applied (dedupe key `backfill-job-keys:v1`).
 *
 * For every external row still missing `last_seen_at` or `expires_at`:
 * - `dedupe_key` = TS normalization (lib/jobs/normalize.ts), with the
 *   location fields derived from the stored `location` text exactly the way
 *   the Muse adapter derives them, so a later sync computes the same key;
 * - `last_seen_at = updated_at` (0009 preserved `updated_at`, which is the
 *   last v1 sync that returned the row);
 * - `expires_at = coalesce(posted_at, created_at) + 60 days`.
 * Columns that are already set are kept. Then `resolve_job_duplicates`
 * over every key. `content_hash` was already filled by the migration.
 *
 * Idempotent: processed rows no longer match the selection, so a re-run
 * (or a retried attempt) only picks up what's left. Near the deadline it
 * snoozes (no attempt used) and carries on from where the selection now
 * starts. User-submitted rows are never touched.
 */

export const BACKFILL_JOB_KEYS_KIND = "maintenance.backfill_job_keys";
export const BACKFILL_JOB_KEYS_DEDUPE_KEY = "backfill-job-keys:v1";
export const BACKFILL_PAGE_SIZE = 100;
export const BACKFILL_EXPIRY_DAYS = 60;
/** Stop starting new pages this long before the task deadline. */
export const BACKFILL_DEADLINE_RESERVE_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const backfillJobKeysPayloadSchema = z.strictObject({});
export type BackfillJobKeysPayload = z.output<typeof backfillJobKeysPayloadSchema>;

/** Values the backfill writes for one row (pure; unit-tested). */
export function computeBackfillValues(row: JobKeyBackfillRow): {
  dedupeKey: string | null;
  lastSeenAt: string;
  expiresAt: string;
} {
  const location =
    row.source === "themuse"
      ? themuseLocationFromText(row.location)
      : { remoteType: null, primaryLocation: null };
  const dedupeKey =
    row.dedupe_key ??
    computeDedupeKey({
      company: row.company,
      title: row.title,
      remoteType: location.remoteType,
      primaryLocation: location.primaryLocation,
    });
  const base = Date.parse(row.posted_at ?? row.created_at);
  return {
    dedupeKey,
    lastSeenAt: row.last_seen_at ?? row.updated_at,
    expiresAt: row.expires_at ?? new Date(base + BACKFILL_EXPIRY_DAYS * DAY_MS).toISOString(),
  };
}

export interface BackfillDeps {
  now?: () => number;
}

export function createBackfillJobKeysHandler(deps: BackfillDeps = {}) {
  const now = deps.now ?? Date.now;

  return async function runBackfillJobKeysTask(
    ctx: TaskContext<BackfillJobKeysPayload>,
  ): Promise<TaskHandlerResult> {
    const { admin, signal, deadline, log } = ctx;
    const keys = new Set<string>();
    let updated = 0;
    let afterId: string | null = null;
    let snooze = false;

    for (;;) {
      if (now() > deadline - BACKFILL_DEADLINE_RESERVE_MS) {
        snooze = true;
        break;
      }
      const rows = await listJobsNeedingKeyBackfill(admin, { afterId, limit: BACKFILL_PAGE_SIZE, signal });
      if (rows.length === 0) break;

      for (const row of rows) {
        const values = computeBackfillValues(row);
        await updateJobKeys(admin, { id: row.id, ...values, signal });
        if (values.dedupeKey) keys.add(values.dedupeKey);
        updated++;
      }
      afterId = rows[rows.length - 1].id;
      if (rows.length < BACKFILL_PAGE_SIZE) break;
    }

    const duplicatesChanged = keys.size > 0 ? await resolveJobDuplicates(admin, keys, { signal }) : 0;
    log.info("job key backfill pass finished", { updated, keys: keys.size, duplicates_changed: duplicatesChanged, more: snooze });

    if (snooze) {
      return { outcome: "snooze", seconds: 5, reason: "backfill_continue" };
    }
    return { outcome: "succeeded", result: { updated, keys: keys.size, duplicates_changed: duplicatesChanged } };
  };
}

export const runBackfillJobKeysTask = createBackfillJobKeysHandler();
