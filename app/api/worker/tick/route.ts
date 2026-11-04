import { randomUUID } from "node:crypto";

import { after, NextResponse } from "next/server";

import { safeErrorName } from "@/lib/tasks/errors";
import { runWorkerTick } from "@/lib/tasks/worker";
import { checkWorkerAuth } from "@/lib/tasks/workerAuth";

/**
 * POST /api/worker/tick — drains the background task queue
 * (docs/ARCHITECTURE.md §13.4.2, §13.13.8).
 *
 * Called by pg_cron every minute (`kalify-worker-tick`, via pg_net with a
 * 5 s timeout) and by `kickWorker()` after user-facing enqueues. Machine to
 * machine: no user session; auth is `Authorization: Bearer ${WORKER_SECRET}`
 * (timing-safe). Unset secret → 500 (fail closed). Wrong secret → 401.
 *
 * Responds `202 { accepted: true }` immediately and runs the worker loop in
 * `after()`, so the caller never holds the connection and a client
 * disconnect can't cut the work short. `after()` runs for the route's
 * `maxDuration`; the loop's own hard budget (285 s) stays under it.
 *
 * Runs on production only: `WORKER_SECRET` must be set on Vercel's
 * Production environment only, never Preview (§13.4.2, §13.18), because
 * previews share the production database.
 */

export const maxDuration = 300;

export async function POST(request: Request) {
  // The invocation's clock starts with the request, not with `after()`.
  const startedAt = Date.now();

  const auth = checkWorkerAuth(request);
  if (!auth.ok) {
    if (auth.status === 500) {
      console.error("POST /api/worker/tick: WORKER_SECRET is not configured; refusing all requests.");
    }
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const invocationId = randomUUID();

  after(async () => {
    try {
      await runWorkerTick({ invocationId, startedAt });
    } catch (err) {
      // e.g. the service-role env vars are missing. No PII to log here.
      console.error(
        "POST /api/worker/tick: worker tick failed:",
        JSON.stringify({ invocation_id: invocationId, error: safeErrorName(err) }),
      );
    }
  });

  return NextResponse.json({ accepted: true }, { status: 202 });
}
