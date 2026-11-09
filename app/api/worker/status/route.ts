import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  countPendingDeadHooks,
  getTaskCounts,
  listRecentDeadTasks,
} from "@/lib/supabase/queries/tasks";
import { getAiSpendSince } from "@/lib/supabase/queries/usage";
import { startOfUtcDay } from "@/lib/tasks/budget";
import { safeErrorName } from "@/lib/tasks/errors";
import { checkWorkerAuth } from "@/lib/tasks/workerAuth";

/**
 * GET /api/worker/status — read-only operator view of the task queue
 * (docs/ARCHITECTURE.md §13.4.5, §13.9.4, §13.13.8). Bearer
 * `WORKER_SECRET`, same rules as the tick route (500 unset / 401 wrong).
 *
 * Response:
 *   {
 *     counts: { [kind]: { [status]: n } },
 *     recent_dead: [{ id, kind, code, attempts, finished_at }],   // 20 most recent
 *     dead_hooks_pending: n,      // dead rows whose onDead hook isn't handled (§13.4.5)
 *     spend_today: { anthropic: usd, voyage: usd },               // since 00:00 UTC
 *     spend_today_by_operation: [{ provider, operation, cost_usd, calls }]
 *   }
 *
 * Never returns payloads, results, or error messages — metadata only.
 * `spend_today_by_operation` is additive to the §13.13.8 shape, from
 * §13.9.4 ("shows today's spend by provider and operation").
 */

export async function GET(request: Request) {
  const auth = checkWorkerAuth(request);
  if (!auth.ok) {
    if (auth.status === 500) {
      console.error("GET /api/worker/status: WORKER_SECRET is not configured; refusing all requests.");
    }
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const admin = createAdminClient();
    const [counts, recentDead, deadHooksPending, spend] = await Promise.all([
      getTaskCounts(admin),
      listRecentDeadTasks(admin, 20),
      countPendingDeadHooks(admin),
      getAiSpendSince(admin, startOfUtcDay(new Date())),
    ]);

    const spendToday = { anthropic: 0, voyage: 0 };
    for (const row of spend) {
      spendToday[row.provider] = roundUsd(spendToday[row.provider] + row.costUsd);
    }

    return NextResponse.json(
      {
        counts,
        recent_dead: recentDead,
        dead_hooks_pending: deadHooksPending,
        spend_today: spendToday,
        spend_today_by_operation: spend.map((row) => ({
          provider: row.provider,
          operation: row.operation,
          cost_usd: roundUsd(row.costUsd),
          calls: row.calls,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("GET /api/worker/status failed:", safeErrorName(err));
    return NextResponse.json(
      { error: "Failed to load worker status." },
      { status: 500 },
    );
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
