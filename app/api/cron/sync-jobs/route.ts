import { after, NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueSourceSyncs } from "@/lib/supabase/queries/sources";
import { kickWorker } from "@/lib/tasks/kick";
import { checkBearerSecret } from "@/lib/tasks/workerAuth";

/**
 * GET /api/cron/sync-jobs — manual operator trigger for job ingestion
 * (docs/ARCHITECTURE.md §13.13.8).
 *
 * Since M1.5 the daily schedule is pg_cron (`kalify-ingest`, 0009) and the
 * `vercel.json` cron entry is gone. This route only calls
 * `enqueue_source_syncs()` (one `ingest.sync_source` task per enabled
 * source/board, idempotent per UTC day) and kicks the worker; it never syncs
 * inline. Responds `202 { enqueued: n }`.
 *
 * Machine to machine: `Authorization: Bearer <CRON_SECRET>`, compared
 * timing-safe. Fails closed: an unset `CRON_SECRET` rejects every request
 * with 500 rather than allowing unauthenticated access to a route that uses
 * the service-role key.
 */
export async function GET(request: Request) {
  const auth = checkBearerSecret(request, process.env.CRON_SECRET, "Sync endpoint is not configured.");
  if (!auth.ok) {
    if (auth.status === 500) {
      console.error("GET /api/cron/sync-jobs: CRON_SECRET is not configured; refusing all requests.");
    }
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const enqueued = await enqueueSourceSyncs(createAdminClient());
    after(async () => {
      await kickWorker();
    });
    return NextResponse.json({ enqueued }, { status: 202 });
  } catch (err) {
    console.error(
      "GET /api/cron/sync-jobs: enqueue_source_syncs failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ error: "Failed to enqueue job syncs." }, { status: 500 });
  }
}
