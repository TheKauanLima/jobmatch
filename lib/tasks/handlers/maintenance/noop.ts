import { z } from "zod";

import { TaskError } from "@/lib/tasks/errors";
import type { BackgroundTaskRow, TaskContext, TaskHandlerResult } from "@/lib/tasks/types";

/**
 * `maintenance.noop` — test kind only (M1.2 acceptance, M1.3 QA). Makes no
 * external calls and touches no user data. Exercises every worker path:
 *
 *   {}                                     → succeeds
 *   {"force_fail": true}                   → retryable internal_error each
 *                                            attempt → backoff → ends dead
 *   {"force_fail": true, "retryable": false} → dead on the first attempt
 *   {"snooze_seconds": 30}                 → snoozes once, on the task's very
 *                                            first claim (no attempt used),
 *                                            then succeeds
 *   {"snooze_seconds": 30, "force_fail": true} → snoozes once, then fails
 *                                            with backoff until dead
 *   {"sleep_ms": 2000}                     → waits (honors the abort signal)
 *
 * Enqueue from SQL, e.g.:
 *   select public.enqueue_task(p_kind => 'maintenance.noop',
 *     p_task_class => 'background', p_max_attempts => 3, p_lease_seconds => 60,
 *     p_payload => '{"force_fail": true}');
 */

export const NOOP_SNOOZE_REASON = "noop_snoozed";

export const noopPayloadSchema = z.strictObject({
  force_fail: z.boolean().optional(),
  retryable: z.boolean().optional(),
  sleep_ms: z.int().min(0).max(5_000).optional(),
  snooze_seconds: z.int().min(5).max(3_600).optional(),
});

export type NoopPayload = z.output<typeof noopPayloadSchema>;

export async function runNoopTask(
  ctx: TaskContext<NoopPayload>,
): Promise<TaskHandlerResult> {
  const { payload, task, signal } = ctx;

  if (payload.sleep_ms) {
    await sleep(payload.sleep_ms, signal);
  }

  // Snooze at most once, ever: only on the task's very first claim. (Not
  // keyed off last_error_code: snooze_task preserves a prior error code, so
  // after a failure that check would never see the snooze and would snooze
  // forever with the attempt refunded each time.)
  if (payload.snooze_seconds && isFirstClaim(task)) {
    return {
      outcome: "snooze",
      seconds: payload.snooze_seconds,
      reason: NOOP_SNOOZE_REASON,
    };
  }

  if (payload.force_fail) {
    throw new TaskError(
      "internal_error",
      "Forced failure (maintenance.noop test task).",
      { retryable: payload.retryable ?? true },
    );
  }

  return { outcome: "succeeded", result: { noop: true, attempt: task.attempts } };
}

/**
 * True only on the first time this task was ever claimed. `claim_tasks`
 * sets `started_at` on the first claim only (kept across snoozes, retries
 * and reclaims) and sets `locked_until = claim time + lease_seconds` on every
 * claim, so the two line up exactly on the first claim and never again.
 * Both come from the same SQL clock value, so sub-millisecond digits match;
 * the 1 ms tolerance only absorbs Date.parse truncation.
 */
export function isFirstClaim(
  task: Pick<BackgroundTaskRow, "started_at" | "locked_until" | "lease_seconds">,
): boolean {
  if (!task.started_at || !task.locked_until) return false;
  const started = Date.parse(task.started_at);
  const claimedAt = Date.parse(task.locked_until) - task.lease_seconds * 1000;
  return Number.isFinite(started) && Number.isFinite(claimedAt) && Math.abs(claimedAt - started) < 1;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
