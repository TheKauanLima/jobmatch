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

/** Passed to `onDead` after `fail_task` returned `dead`. */
export interface DeadTaskContext<P> {
  task: BackgroundTaskRow;
  /** null when the payload itself failed validation (`unknown_payload`). */
  payload: P | null;
  admin: AdminClient;
  errorCode: string;
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
   * Called once when the task ends `dead`, in the same worker path that
   * called `fail_task` (§13.4.5): set the root row (report stage, match,
   * import) to `failed` with a user-safe error code. Must be idempotent.
   */
  onDead?: (ctx: DeadTaskContext<z.output<S>>) => Promise<void>;
  /**
   * Called when the global AI budget snoozes this task (§13.9.4), e.g. to
   * set `resume_reports.notice = 'delayed_budget'`. Must be idempotent.
   */
  onBudgetDelayed?: (ctx: BudgetDelayedContext<z.output<S>>) => Promise<void>;
}
