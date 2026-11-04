import { z } from "zod";

import { TaskError } from "@/lib/tasks/errors";
import type { TaskContext, TaskHandlerResult } from "@/lib/tasks/types";

/**
 * `maintenance.noop` — test kind only (M1.2 acceptance, M1.3 QA). Makes no
 * external calls and touches no user data. Exercises every worker path:
 *
 *   {}                                     → succeeds
 *   {"force_fail": true}                   → retryable internal_error each
 *                                            attempt → backoff → ends dead
 *   {"force_fail": true, "retryable": false} → dead on the first attempt
 *   {"snooze_seconds": 30}                 → snoozes once (no attempt used),
 *                                            then succeeds
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

  // Snooze only once: the snooze reason is left in last_error_code, so the
  // re-claimed attempt proceeds instead of snoozing forever.
  if (payload.snooze_seconds && task.last_error_code !== NOOP_SNOOZE_REASON) {
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
