import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  backfillJobFacets,
  FacetBackfillError,
  type FacetBackfillResult,
} from "@/lib/jobs/backfillFacets";
import { syncExternalJobs } from "@/lib/jobs/sync";

/**
 * Vercel Hobby functions get at most 60 s; the sync itself stops starting new
 * board fetches after 40 s (docs/ARCHITECTURE.md §7.7.5).
 */
export const maxDuration = 60;

/** The facet backfill starts no new update after run start + this (§7.8.4). */
export const FACET_BACKFILL_DEADLINE_MS = 50_000;

/**
 * GET /api/cron/sync-jobs — polls the curated Greenhouse and Lever company
 * job boards (`lib/jobs/sources/companies.ts`), upserts student-relevant US
 * listings into the shared `job_descriptions` board, and soft-deletes
 * listings that have left their board. See docs/ARCHITECTURE.md §7.7 (this
 * replaced The Muse) and §7.3 for the trigger/auth design.
 *
 * Not a user-facing endpoint — there is no session to check, since this is
 * meant to be called by a scheduler with no logged-in user (Vercel Cron per
 * `vercel.json`, or any external scheduler hitting this URL directly).
 * Authorization is instead a shared-secret check: the caller must send
 * `Authorization: Bearer <CRON_SECRET>` matching the `CRON_SECRET` env var.
 * Vercel Cron sends exactly this header automatically for routes listed in
 * `vercel.json`, once `CRON_SECRET` is set as a project env var (see
 * https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs) —
 * no extra wiring needed beyond setting that env var.
 *
 * Fails *closed*, not open: if `CRON_SECRET` isn't configured at all, every
 * request is rejected (500) rather than allowing unauthenticated access —
 * an unset secret must never silently become "no auth required" for an
 * endpoint that writes to the shared job board using the service-role key.
 *
 * After the sync, `backfillJobFacets` fills the board-filter facets on rows
 * that don't have them yet (docs/ARCHITECTURE.md §7.8.4), starting no new
 * update after run start + `FACET_BACKFILL_DEADLINE_MS`. The body gains
 * `facetBackfill: { updated, remaining }`.
 *
 * Responses: 200 when every company synced `ok` and the backfill succeeded;
 * 207 (body = the full per-company result) when any company was
 * `not_found`, `error`, or `skipped_time_budget`, or the backfill failed;
 * 502 only if `syncExternalJobs` itself throws.
 */
export async function GET(request: Request) {
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret) {
    console.error(
      "GET /api/cron/sync-jobs: CRON_SECRET is not configured — refusing all requests.",
    );
    return NextResponse.json(
      { error: "Sync endpoint is not configured." },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runStartedAt = Date.now();
  try {
    const supabase = createAdminClient();
    const result = await syncExternalJobs(supabase);

    let facetBackfill: FacetBackfillResult;
    let facetBackfillFailed = false;
    try {
      facetBackfill = await backfillJobFacets(supabase, {
        deadlineMs: runStartedAt + FACET_BACKFILL_DEADLINE_MS,
      });
    } catch (err) {
      facetBackfillFailed = true;
      facetBackfill = {
        updated: err instanceof FacetBackfillError ? err.updated : 0,
        remaining: true,
      };
      console.error(
        "GET /api/cron/sync-jobs: facet backfill failed:",
        err instanceof Error ? err.message : "unknown error",
      );
    }

    const notOk = result.companies.filter((c) => c.status !== "ok");
    if (notOk.length > 0) {
      // Per-company errors are already short (provider/token/status only).
      console.error(
        "GET /api/cron/sync-jobs: partial failure:",
        notOk.map((c) => `${c.provider}:${c.token}=${c.status}`).join(", "),
      );
    }

    return NextResponse.json(
      { ...result, facetBackfill },
      { status: notOk.length > 0 || facetBackfillFailed ? 207 : 200 },
    );
  } catch (err) {
    console.error(
      "GET /api/cron/sync-jobs failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to sync job listings." },
      { status: 502 },
    );
  }
}
