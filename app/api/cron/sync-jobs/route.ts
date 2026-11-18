import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { syncThemuseJobs } from "@/lib/jobs/sync";

/**
 * GET /api/cron/sync-jobs — pulls the latest Internship/Entry Level listings
 * from The Muse and upserts them into the shared `job_descriptions` board.
 * See docs/ARCHITECTURE.md §7 for the full design rationale.
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

  try {
    const supabase = createAdminClient();
    const result = await syncThemuseJobs(supabase);

    const hadError = result.levels.some((level) => level.error !== null);
    if (hadError) {
      console.error("GET /api/cron/sync-jobs: partial failure:", result);
    }

    return NextResponse.json(result, { status: hadError ? 207 : 200 });
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
