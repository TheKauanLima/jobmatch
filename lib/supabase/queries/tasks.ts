import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  BackgroundTaskClass,
  BackgroundTaskStatus,
  Database,
  Json,
} from "@/types/database";

/**
 * Thin wrappers over the `background_tasks` table and its task functions
 * (supabase/migrations/0007_background_infra.sql, docs/ARCHITECTURE.md
 * §13.3.1). Every function here takes the **service-role** client: the
 * table is server-only and every task function's EXECUTE is revoked from
 * anon/authenticated. This file is inside the §13.14 service-role boundary
 * (`lib/supabase/queries/tasks.ts`); callers are `lib/tasks/**`,
 * `app/api/worker/**`, and account deletion (`cancelTasksForUser`).
 *
 * Error messages carry the operation name plus PostgREST's code/message
 * only — never payload contents or row data.
 */

export type AdminClient = SupabaseClient<Database>;
export type BackgroundTaskRow =
  Database["public"]["Tables"]["background_tasks"]["Row"];

export class TaskQueryError extends Error {
  readonly code: string | null;

  constructor(operation: string, error: { code?: string | null; message?: string | null }) {
    const code = error.code ?? null;
    const detail = (error.message ?? "unknown error").slice(0, 300);
    super(`${operation} failed${code ? ` (${code})` : ""}: ${detail}`);
    this.name = "TaskQueryError";
    this.code = code;
  }
}

export interface EnqueueTaskRowArgs {
  kind: string;
  taskClass: BackgroundTaskClass;
  payload: Json;
  userId: string | null;
  dedupeKey: string | null;
  priority: number;
  maxAttempts: number;
  leaseSeconds: number;
  runAfter: Date | null;
  correlationId: string | null;
  parentTaskId: string | null;
}

/** Returns the new task id, or the existing live task's id on dedupe. */
export async function enqueueTaskRow(
  admin: AdminClient,
  args: EnqueueTaskRowArgs,
): Promise<string> {
  const { data, error } = await admin.rpc("enqueue_task", {
    p_kind: args.kind,
    p_task_class: args.taskClass,
    p_payload: args.payload,
    p_user_id: args.userId,
    p_dedupe_key: args.dedupeKey,
    p_priority: args.priority,
    p_max_attempts: args.maxAttempts,
    p_lease_seconds: args.leaseSeconds,
    p_run_after: args.runAfter ? args.runAfter.toISOString() : null,
    p_correlation_id: args.correlationId,
    p_parent_task_id: args.parentTaskId,
  });

  if (error) throw new TaskQueryError("enqueue_task", error);
  if (typeof data !== "string") {
    throw new TaskQueryError("enqueue_task", { message: "no task id returned" });
  }
  return data;
}

export async function claimTasks(
  admin: AdminClient,
  args: {
    workerId: string;
    taskClass: BackgroundTaskClass;
    kinds: string[];
    maxRunning: number;
    limit: number;
  },
): Promise<BackgroundTaskRow[]> {
  if (args.kinds.length === 0 || args.limit <= 0) return [];

  const { data, error } = await admin.rpc("claim_tasks", {
    p_worker_id: args.workerId,
    p_task_class: args.taskClass,
    p_kinds: args.kinds,
    p_max_running: args.maxRunning,
    p_limit: args.limit,
  });

  if (error) throw new TaskQueryError("claim_tasks", error);
  return (data ?? []) as BackgroundTaskRow[];
}

/** false = fenced out (this worker no longer holds the task). */
export async function completeTask(
  admin: AdminClient,
  id: string,
  workerId: string,
  result: Json | null,
): Promise<boolean> {
  const { data, error } = await admin.rpc("complete_task", {
    p_id: id,
    p_worker_id: workerId,
    p_result: result,
  });
  if (error) throw new TaskQueryError("complete_task", error);
  return data === true;
}

/** New status, or null when fenced out. */
export async function failTask(
  admin: AdminClient,
  args: {
    id: string;
    workerId: string;
    errorCode: string;
    errorMessage: string | null;
    retryable: boolean;
    retryDelaySeconds: number;
  },
): Promise<"queued" | "dead" | null> {
  const { data, error } = await admin.rpc("fail_task", {
    p_id: args.id,
    p_worker_id: args.workerId,
    p_error_code: args.errorCode,
    p_error_message: args.errorMessage,
    p_retryable: args.retryable,
    p_retry_delay_seconds: args.retryDelaySeconds,
  });
  if (error) throw new TaskQueryError("fail_task", error);
  return data === "queued" || data === "dead" ? data : null;
}

/** false = fenced out. */
export async function snoozeTask(
  admin: AdminClient,
  args: { id: string; workerId: string; seconds: number; reason: string },
): Promise<boolean> {
  const { data, error } = await admin.rpc("snooze_task", {
    p_id: args.id,
    p_worker_id: args.workerId,
    p_seconds: args.seconds,
    p_reason: args.reason,
  });
  if (error) throw new TaskQueryError("snooze_task", error);
  return data === true;
}

/** false = fenced out. */
export async function extendTaskLease(
  admin: AdminClient,
  id: string,
  workerId: string,
  seconds: number,
): Promise<boolean> {
  const { data, error } = await admin.rpc("extend_task_lease", {
    p_id: id,
    p_worker_id: workerId,
    p_seconds: seconds,
  });
  if (error) throw new TaskQueryError("extend_task_lease", error);
  return data === true;
}

/**
 * Account deletion (§13.13.7): cancels the user's queued tasks. `userId`
 * must come from the verified session, never from request input.
 * Returns the number of tasks cancelled.
 */
export async function cancelTasksForUser(
  admin: AdminClient,
  userId: string,
): Promise<number> {
  const { data, error } = await admin.rpc("cancel_tasks_for_user", {
    p_user_id: userId,
  });
  if (error) throw new TaskQueryError("cancel_tasks_for_user", error);
  return typeof data === "number" ? data : 0;
}

/**
 * Whether any task of the given class/kinds is claimable right now
 * (`queued` with `run_after <= now`). Used for the worker's self-kick
 * decision (§13.4.2). Expired leases are not considered here; the
 * every-minute cron tick reclaims those.
 */
export async function hasClaimableTasks(
  admin: AdminClient,
  args: { taskClass: BackgroundTaskClass; kinds: string[]; now: Date },
): Promise<boolean> {
  if (args.kinds.length === 0) return false;

  const { data, error } = await admin
    .from("background_tasks")
    .select("id")
    .eq("status", "queued")
    .eq("task_class", args.taskClass)
    .in("kind", args.kinds)
    .lte("run_after", args.now.toISOString())
    .limit(1);

  if (error) throw new TaskQueryError("has_claimable_tasks", error);
  return (data ?? []).length > 0;
}

export type TaskCounts = Record<string, Partial<Record<BackgroundTaskStatus, number>>>;

/** `{ [kind]: { [status]: n } }` for GET /api/worker/status. */
export async function getTaskCounts(admin: AdminClient): Promise<TaskCounts> {
  const { data, error } = await admin.rpc("background_task_counts");
  if (error) throw new TaskQueryError("background_task_counts", error);

  const counts: TaskCounts = {};
  for (const row of data ?? []) {
    const byStatus = (counts[row.kind] ??= {});
    byStatus[row.status] = Number(row.n);
  }
  return counts;
}

export interface RecentDeadTask {
  id: string;
  kind: string;
  code: string | null;
  attempts: number;
  finished_at: string | null;
}

/**
 * Most recent dead tasks for GET /api/worker/status (§13.4.5). Selects
 * metadata columns only — never payload, result, or error message.
 */
export async function listRecentDeadTasks(
  admin: AdminClient,
  limit = 20,
): Promise<RecentDeadTask[]> {
  const { data, error } = await admin
    .from("background_tasks")
    .select("id, kind, last_error_code, attempts, finished_at")
    .eq("status", "dead")
    .order("finished_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw new TaskQueryError("list_recent_dead_tasks", error);
  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    code: row.last_error_code,
    attempts: row.attempts,
    finished_at: row.finished_at,
  }));
}
