import type { z } from "zod";

import type {
  AdminClient,
  BackgroundTaskRow,
} from "@/lib/supabase/queries/tasks";
import type { BackgroundTaskClass, Json } from "@/types/database";

/**
 * Shared types for the background task system (docs/ARCHITECTURE.md §13.4).
 * Naming rule (§13.1): background work units are "tasks", never "jobs".
 */

export type { AdminClient, BackgroundTaskRow };
export type TaskClass = BackgroundTaskClass;

/**
 * Structured, PII-free logging for task code. Field values are primitives
 * only, so a whole resume/listing object can't be dumped by accident.
 * Never pass resume/listing/fetched-page text, prompts, or model output.
 */
export type LogFields = Record<string, string | number | boolean | null>;

export interface TaskLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** What a handler receives (§13.4.3), plus the already-validated payload. */
export interface TaskContext<P> {
  /** The claimed row (attempts already incremented for this attempt). */
  task: BackgroundTaskRow;
  /** `task.payload` parsed through the kind's `payloadSchema`. */
  payload: P;
  /** Service-role client. Every query on user data must filter by `task.user_id`. */
  admin: AdminClient;
  /**
   * Fires at handler start + `maxDurationMs`. Pass it as `signal` to every
   * Anthropic / Voyage / fetch call.
   */
  signal: AbortSignal;
  /** Epoch ms at which `signal` fires. */
  deadline: number;
  log: TaskLogger;
}

/** A handler returns one of these, or throws a `TaskError` (§13.4.3). */
export type TaskHandlerResult =
  | { outcome: "succeeded"; result?: Json }
  | { outcome: "snooze"; seconds: number; reason: string };

/**
 * Passed to `onDead`, delivered through the dead-task hook outbox
 * (§13.4.5), whichever path killed the task (`fail_task`, `claim_tasks`
 * lease_expired, the stale-lease sweep).
 */
export interface DeadTaskContext<P> {
  task: BackgroundTaskRow;
  /** null when the payload fails `payloadSchema` (e.g. `unknown_payload`). */
  payload: P | null;
  admin: AdminClient;
  /** `task.last_error_code` (e.g. `lease_expired`, `ai_refused`). */
  errorCode: string;
  /** Fires at the per-hook timeout; pass it to any database call. */
  signal: AbortSignal;
  log: TaskLogger;
}

/** Passed to `onBudgetDelayed` when the global AI budget snoozes a task. */
export interface BudgetDelayedContext<P> {
  task: BackgroundTaskRow;
  payload: P | null;
  admin: AdminClient;
  log: TaskLogger;
}

export interface TaskDefinition<S extends z.ZodType = z.ZodType> {
  /** Task class: concurrency partition (§13.4.2). */
  class: TaskClass;
  /** Higher runs first. */
  priority: number;
  maxAttempts: number;
  /** Must exceed `maxDurationMs` by at least 30 s (registry invariant). */
  leaseSeconds: number;
  /** Hard per-attempt budget; the worker aborts `signal` at this point. */
  maxDurationMs: number;
  /**
   * True when the handler calls a paid AI API (Claude or Voyage). Such
   * kinds are gated by the global daily AI budget (§13.9.4).
   */
  usesAi: boolean;
  /** Validates `payload` (ids and small enums only — never text or PII). */
  payloadSchema: S;
  handler: (ctx: TaskContext<z.output<S>>) => Promise<TaskHandlerResult>;
  /**
   * Runs when the task is `dead`, to set the root row (report stage, match,
   * import) to `failed` with a user-safe error code and apply the §13.10.4
   * refund (§13.4.5).
   *
   * HOOK CONTRACT (binding):
   * - Delivered AT LEAST ONCE via the outbox (claim_dead_task_hooks), so it
   *   may run more than once and must be idempotent.
   * - Conditional writes only: mark a stage/root row `failed` only if it
   *   isn't already terminal; refund with `... set refunded_at = now()
   *   where ref_id = ... and refunded_at is null`; never insert
   *   unconditionally.
   * - Must finish well inside the 20 s hook budget: no AI calls and no
   *   external HTTP. Database writes only, filtered by `task.user_id`.
   * - Throwing leaves the hook pending; it is retried on a later tick and
   *   given up (with an alert) after 10 attempts.
   */
  onDead?: (ctx: DeadTaskContext<z.output<S>>) => Promise<void>;
  /**
   * Called when the global AI budget snoozes this task (§13.9.4), e.g. to
   * set `resume_reports.notice = 'delayed_budget'`. Must be idempotent.
   */
  onBudgetDelayed?: (ctx: BudgetDelayedContext<z.output<S>>) => Promise<void>;
}
