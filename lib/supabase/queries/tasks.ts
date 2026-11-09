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
 * `app/api/worker/**`, and account deletion (`cancelQueuedTasksForUser`).
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

/**
 * Per-call options. `signal` aborts the underlying PostgREST request (the
 * worker passes `AbortSignal.timeout(...)` so a hung call can't keep a tick
 * alive until the platform's hard kill). An aborted call surfaces as a
 * `TaskQueryError`. Note that the database may still have committed the
 * statement; every caller tolerates that (leases expire and are reclaimed).
 */
export interface QueryOptions {
  signal?: AbortSignal;
}

/** Attaches `signal` to a PostgREST builder when one is given. */
function withSignal<B extends { abortSignal(signal: AbortSignal): B }>(
  builder: B,
  options: QueryOptions | undefined,
): B {
  return options?.signal ? builder.abortSignal(options.signal) : builder;
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
  options?: QueryOptions,
): Promise<BackgroundTaskRow[]> {
  if (args.kinds.length === 0 || args.limit <= 0) return [];

  const { data, error } = await withSignal(
    admin.rpc("claim_tasks", {
      p_worker_id: args.workerId,
      p_task_class: args.taskClass,
      p_kinds: args.kinds,
      p_max_running: args.maxRunning,
      p_limit: args.limit,
    }),
    options,
  );

  if (error) throw new TaskQueryError("claim_tasks", error);
  return (data ?? []) as BackgroundTaskRow[];
}

/** false = fenced out (this worker no longer holds the task). */
export async function completeTask(
  admin: AdminClient,
  id: string,
  workerId: string,
  result: Json | null,
  options?: QueryOptions,
): Promise<boolean> {
  const { data, error } = await withSignal(
    admin.rpc("complete_task", {
      p_id: id,
      p_worker_id: workerId,
      p_result: result,
    }),
    options,
  );
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
  options?: QueryOptions,
): Promise<"queued" | "dead" | null> {
  const { data, error } = await withSignal(
    admin.rpc("fail_task", {
      p_id: args.id,
      p_worker_id: args.workerId,
      p_error_code: args.errorCode,
      p_error_message: args.errorMessage,
      p_retryable: args.retryable,
      p_retry_delay_seconds: args.retryDelaySeconds,
    }),
    options,
  );
  if (error) throw new TaskQueryError("fail_task", error);
  return data === "queued" || data === "dead" ? data : null;
}

/** false = fenced out. */
export async function snoozeTask(
  admin: AdminClient,
  args: { id: string; workerId: string; seconds: number; reason: string },
  options?: QueryOptions,
): Promise<boolean> {
  const { data, error } = await withSignal(
    admin.rpc("snooze_task", {
      p_id: args.id,
      p_worker_id: args.workerId,
      p_seconds: args.seconds,
      p_reason: args.reason,
    }),
    options,
  );
  if (error) throw new TaskQueryError("snooze_task", error);
  return data === true;
}

/**
 * Global-budget deferral (§13.9.4): moves claimable queued tasks of `kinds`
 * to `until` + random jitter WITHOUT claiming them (no attempt consumed,
 * started_at / last_error_code untouched). Returns the deferred rows.
 */
export async function deferQueuedTasks(
  admin: AdminClient,
  args: {
    taskClass: BackgroundTaskClass;
    kinds: string[];
    until: Date;
    maxJitterSeconds: number;
    limit: number;
  },
  options?: QueryOptions,
): Promise<BackgroundTaskRow[]> {
  if (args.kinds.length === 0 || args.limit <= 0) return [];

  const { data, error } = await withSignal(
    admin.rpc("defer_queued_tasks", {
      p_task_class: args.taskClass,
      p_kinds: args.kinds,
      p_until: args.until.toISOString(),
      p_max_jitter_seconds: args.maxJitterSeconds,
      p_limit: args.limit,
    }),
    options,
  );
  if (error) throw new TaskQueryError("defer_queued_tasks", error);
  return (data ?? []) as BackgroundTaskRow[];
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
 * Account deletion (§13.13.7 step 2): sets the user's `queued` tasks to
 * `cancelled` via `cancel_tasks_for_user`. `userId` must come from the
 * verified session, never from request input. Idempotent, so a retried
 * deletion can call it again. Throws `TaskQueryError` on an RPC error; the
 * caller treats that as fatal before anything is deleted.
 * Returns the number of tasks cancelled.
 */
export async function cancelQueuedTasksForUser(
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
  options?: QueryOptions,
): Promise<boolean> {
  if (args.kinds.length === 0) return false;

  const { data, error } = await withSignal(
    admin
      .from("background_tasks")
      .select("id")
      .eq("status", "queued")
      .eq("task_class", args.taskClass)
      .in("kind", args.kinds)
      .lte("run_after", args.now.toISOString())
      .limit(1),
    options,
  );

  if (error) throw new TaskQueryError("has_claimable_tasks", error);
  return (data ?? []).length > 0;
}

/**
 * Dead-task hook outbox (§13.4.5): locks up to `limit` pending onDead hooks
 * of `kinds` for 120 s (incrementing `on_dead_attempts`). With `taskId`,
 * only that task is considered (the worker's fast path).
 */
export async function claimDeadTaskHooks(
  admin: AdminClient,
  args: { workerId: string; kinds: string[]; limit: number; taskId?: string | null },
  options?: QueryOptions,
): Promise<BackgroundTaskRow[]> {
  if (args.kinds.length === 0 || args.limit <= 0) return [];
  const { data, error } = await withSignal(
    admin.rpc("claim_dead_task_hooks", {
      p_worker_id: args.workerId,
      p_kinds: args.kinds,
      p_limit: args.limit,
      p_task_id: args.taskId ?? null,
    }),
    options,
  );
  if (error) throw new TaskQueryError("claim_dead_task_hooks", error);
  return (data ?? []) as BackgroundTaskRow[];
}

/** Marks a hook handled. false = fenced out or already handled. */
export async function completeDeadTaskHook(
  admin: AdminClient,
  args: { id: string; workerId: string; gaveUp: boolean },
  options?: QueryOptions,
): Promise<boolean> {
  const { data, error } = await withSignal(
    admin.rpc("complete_dead_task_hook", {
      p_id: args.id,
      p_worker_id: args.workerId,
      p_gave_up: args.gaveUp,
    }),
    options,
  );
  if (error) throw new TaskQueryError("complete_dead_task_hook", error);
  return data === true;
}

/**
 * Releases a claimed-but-unrun hook (clears the lock, refunds the attempt).
 * false = fenced out or already handled.
 */
export async function releaseDeadTaskHook(
  admin: AdminClient,
  args: { id: string; workerId: string },
  options?: QueryOptions,
): Promise<boolean> {
  const { data, error } = await withSignal(
    admin.rpc("release_dead_task_hook", {
      p_id: args.id,
      p_worker_id: args.workerId,
    }),
    options,
  );
  if (error) throw new TaskQueryError("release_dead_task_hook", error);
  return data === true;
}

/**
 * Dead tasks whose onDead hook hasn't been handled (status route's
 * `dead_hooks_pending`). A HEAD count, so it isn't capped by max_rows.
 */
export async function countPendingDeadHooks(admin: AdminClient): Promise<number> {
  const { count, error } = await admin
    .from("background_tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "dead")
    .is("on_dead_handled_at", null);
  if (error) throw new TaskQueryError("count_pending_dead_hooks", error);
  return count ?? 0;
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
