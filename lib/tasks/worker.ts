import { createAdminClient } from "@/lib/supabase/admin";
import {
  claimTasks,
  completeTask,
  failTask,
  hasClaimableTasks,
  snoozeTask,
  type AdminClient,
  type BackgroundTaskRow,
} from "@/lib/supabase/queries/tasks";
import { getAiSpendSince } from "@/lib/supabase/queries/usage";
import {
  checkGlobalAiBudget,
  getGlobalDailyAiBudgetUsd,
  secondsUntilBudgetReset,
  type BudgetStatus,
} from "@/lib/tasks/budget";
import {
  classifyTaskError,
  computeBackoffSeconds,
  safeErrorName,
  TaskError,
  type TaskErrorCode,
} from "@/lib/tasks/errors";
import { kickWorker } from "@/lib/tasks/kick";
import {
  getTaskDefinition,
  kindsForClass,
  taskRegistry,
  type TaskRegistry,
} from "@/lib/tasks/registry";
import type {
  LogFields,
  TaskClass,
  TaskDefinition,
  TaskHandlerResult,
  TaskLogger,
} from "@/lib/tasks/types";
import type { Json } from "@/types/database";

/**
 * The worker loop (docs/ARCHITECTURE.md §13.4.2). Runs inside `after()` in
 * `POST /api/worker/tick`.
 *
 * - Hard budget 285 s: a task is only claimed if `elapsed + maxDurationMs <
 *   WORKER_HARD_BUDGET_MS`; `claim_tasks` gets only the kinds that still fit.
 * - In-process pool: up to 4 `user` + 2 `background` tasks at once. The same
 *   numbers go to `claim_tasks` as `p_max_running`, which counts live leases
 *   under an advisory lock, so the caps are global across concurrent ticks.
 *   `user` is claimed first on every iteration.
 * - Loop: claim → run concurrently → as each finishes, claim more → stop
 *   claiming at 240 s → await in-flight → return.
 * - Global AI budget (§13.9.4): checked before claiming AI-calling kinds.
 *   Over budget → those tasks are snoozed to the next UTC midnight + jitter
 *   without running. Check failed → AI kinds are not claimed this round.
 * - Self-chaining: if at least one task was processed and claimable `user`
 *   tasks remain, kick once. The every-minute cron tick is the backstop.
 *
 * Logging is PII-free: ids, kinds, codes and counts only.
 */

export const WORKER_HARD_BUDGET_MS = 285_000;
export const WORKER_SOFT_STOP_MS = 240_000;
export const WORKER_MAX_RUNNING_USER = 4;
export const WORKER_MAX_RUNNING_BACKGROUND = 2;

export const WORKER_CLASS_CAPS: Readonly<Record<TaskClass, number>> = {
  user: WORKER_MAX_RUNNING_USER,
  background: WORKER_MAX_RUNNING_BACKGROUND,
};

/** `user` first on every iteration (§13.4.2). */
const CLASS_ORDER: readonly TaskClass[] = ["user", "background"];

/** Bounds on handler-requested snoozes (a 0 s snooze would spin the loop). */
export const MIN_SNOOZE_SECONDS = 5;
export const MAX_SNOOZE_SECONDS = 7 * 24 * 60 * 60;

/** `background_tasks.result` is a small summary; larger results are replaced. */
export const MAX_RESULT_BYTES = 4096;

const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Persistence operations the loop needs (injectable for tests). */
export interface WorkerStore {
  claim(args: {
    workerId: string;
    taskClass: TaskClass;
    kinds: string[];
    maxRunning: number;
    limit: number;
  }): Promise<BackgroundTaskRow[]>;
  complete(id: string, workerId: string, result: Json | null): Promise<boolean>;
  fail(args: {
    id: string;
    workerId: string;
    errorCode: string;
    errorMessage: string | null;
    retryable: boolean;
    retryDelaySeconds: number;
  }): Promise<"queued" | "dead" | null>;
  snooze(args: {
    id: string;
    workerId: string;
    seconds: number;
    reason: string;
  }): Promise<boolean>;
  hasClaimableTasks(args: {
    taskClass: TaskClass;
    kinds: string[];
    now: Date;
  }): Promise<boolean>;
  /** Total USD spent since `since` (summed in SQL). */
  getAiSpendSince(since: Date): Promise<number>;
}

export function createWorkerStore(admin: AdminClient): WorkerStore {
  return {
    claim: (args) => claimTasks(admin, args),
    complete: (id, workerId, result) => completeTask(admin, id, workerId, result),
    fail: (args) => failTask(admin, args),
    snooze: (args) => snoozeTask(admin, args),
    hasClaimableTasks: (args) => hasClaimableTasks(admin, args),
    getAiSpendSince: async (since) => {
      const rows = await getAiSpendSince(admin, since);
      return rows.reduce((sum, row) => sum + row.costUsd, 0);
    },
  };
}

export type WorkerLogLevel = "info" | "warn" | "error";
export type WorkerLogSink = (
  level: WorkerLogLevel,
  message: string,
  fields: LogFields,
) => void;

const consoleLogSink: WorkerLogSink = (level, message, fields) => {
  const line = `[worker] ${message} ${JSON.stringify(fields)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
};

export interface WorkerDeps {
  admin: AdminClient;
  store: WorkerStore;
  registry: TaskRegistry;
  now: () => number;
  random: () => number;
  kick: () => Promise<boolean>;
  budgetUsd: number;
  logSink: WorkerLogSink;
}

export type WorkerStopReason = "idle" | "soft_stop" | "claim_error";

export interface WorkerTickSummary {
  invocationId: string;
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
  snoozed: number;
  budgetSnoozed: number;
  /** complete/fail/snooze was a no-op because another worker now holds the task. */
  fencedOut: number;
  /** A complete/fail/snooze call itself errored; lease expiry will recover. */
  storeErrors: number;
  kicked: boolean;
  stopReason: WorkerStopReason;
  durationMs: number;
}

/** Thrown into a handler's race when its `maxDurationMs` elapses. */
export class TaskDeadlineError extends Error {
  constructor() {
    super("Task exceeded its time budget.");
    this.name = "TaskDeadlineError";
  }
}

export async function runWorkerTick(
  params: { invocationId: string; startedAt: number },
  overrides: Partial<WorkerDeps> = {},
): Promise<WorkerTickSummary> {
  const admin = overrides.admin ?? createAdminClient();
  const deps: WorkerDeps = {
    admin,
    store: overrides.store ?? createWorkerStore(admin),
    registry: overrides.registry ?? taskRegistry,
    now: overrides.now ?? Date.now,
    random: overrides.random ?? Math.random,
    kick: overrides.kick ?? (() => kickWorker()),
    budgetUsd: overrides.budgetUsd ?? getGlobalDailyAiBudgetUsd(),
    logSink: overrides.logSink ?? consoleLogSink,
  };

  const { invocationId, startedAt } = params;
  const { store, registry } = deps;

  const summary: WorkerTickSummary = {
    invocationId,
    claimed: 0,
    succeeded: 0,
    retried: 0,
    dead: 0,
    snoozed: 0,
    budgetSnoozed: 0,
    fencedOut: 0,
    storeErrors: 0,
    kicked: false,
    stopReason: "idle",
    durationMs: 0,
  };

  const log = (level: WorkerLogLevel, message: string, fields: LogFields = {}) =>
    deps.logSink(level, message, { invocation_id: invocationId, ...fields });

  const taskLogger = (row: BackgroundTaskRow): TaskLogger => {
    const base: LogFields = { task_id: row.id, kind: row.kind, attempt: row.attempts };
    return {
      info: (m, f) => log("info", m, { ...base, ...f }),
      warn: (m, f) => log("warn", m, { ...base, ...f }),
      error: (m, f) => log("error", m, { ...base, ...f }),
    };
  };

  // ---- store calls that must never throw out of a task run --------------

  const safeComplete = async (row: BackgroundTaskRow, result: Json | null) => {
    try {
      const ok = await store.complete(row.id, invocationId, result);
      if (ok) summary.succeeded++;
      else {
        summary.fencedOut++;
        taskLogger(row).warn("complete_task fenced out (lease lost)");
      }
    } catch (err) {
      summary.storeErrors++;
      taskLogger(row).error("complete_task errored; lease expiry will recover", {
        error: safeErrorName(err),
      });
    }
  };

  const safeSnooze = async (row: BackgroundTaskRow, seconds: number, reason: string) => {
    try {
      const ok = await store.snooze({ id: row.id, workerId: invocationId, seconds, reason });
      if (!ok) {
        summary.fencedOut++;
        taskLogger(row).warn("snooze_task fenced out (lease lost)");
      }
      return ok;
    } catch (err) {
      summary.storeErrors++;
      taskLogger(row).error("snooze_task errored; lease expiry will recover", {
        error: safeErrorName(err),
      });
      return false;
    }
  };

  const safeFail = async (
    row: BackgroundTaskRow,
    failure: { code: TaskErrorCode; retryable: boolean; message: string | null },
  ): Promise<"queued" | "dead" | null | undefined> => {
    const retryDelaySeconds = computeBackoffSeconds(row.attempts, deps.random);
    try {
      const status = await store.fail({
        id: row.id,
        workerId: invocationId,
        errorCode: failure.code,
        errorMessage: failure.message,
        retryable: failure.retryable,
        retryDelaySeconds,
      });
      const fields = { code: failure.code, retryable: failure.retryable };
      if (status === "queued") {
        summary.retried++;
        taskLogger(row).warn("task failed; retry scheduled", { ...fields, retry_in_s: retryDelaySeconds });
      } else if (status === "dead") {
        summary.dead++;
        taskLogger(row).error("task failed; dead-lettered", fields);
      } else {
        summary.fencedOut++;
        taskLogger(row).warn("fail_task fenced out (lease lost)", fields);
      }
      return status;
    } catch (err) {
      summary.storeErrors++;
      taskLogger(row).error("fail_task errored; lease expiry will recover", {
        code: failure.code,
        error: safeErrorName(err),
      });
      return undefined;
    }
  };

  const runOnDead = async (
    def: TaskDefinition,
    row: BackgroundTaskRow,
    payload: unknown,
    errorCode: string,
  ) => {
    if (!def.onDead) return;
    try {
      await def.onDead({ task: row, payload, admin: deps.admin, errorCode, log: taskLogger(row) });
    } catch (err) {
      taskLogger(row).error("onDead hook errored", { error: safeErrorName(err) });
    }
  };

  const parsePayload = (def: TaskDefinition, row: BackgroundTaskRow) =>
    def.payloadSchema.safeParse(row.payload);

  // ---- per-task execution ------------------------------------------------

  const budgetSnooze = async (row: BackgroundTaskRow, def: TaskDefinition) => {
    const seconds = secondsUntilBudgetReset(new Date(deps.now()), deps.random);
    const ok = await safeSnooze(row, seconds, "budget_exhausted");
    if (!ok) return;
    summary.budgetSnoozed++;
    if (def.onBudgetDelayed) {
      const parsed = parsePayload(def, row);
      try {
        await def.onBudgetDelayed({
          task: row,
          payload: parsed.success ? parsed.data : null,
          admin: deps.admin,
          log: taskLogger(row),
        });
      } catch (err) {
        taskLogger(row).error("onBudgetDelayed hook errored", { error: safeErrorName(err) });
      }
    }
  };

  const runTask = async (row: BackgroundTaskRow, def: TaskDefinition | undefined) => {
    const tlog = taskLogger(row);

    if (!def) {
      // Unreachable: claim_tasks only returns kinds we asked for.
      await safeFail(row, {
        code: "internal_error",
        retryable: true,
        message: "Claimed a kind missing from this deployment's registry.",
      });
      return;
    }

    const parsed = parsePayload(def, row);
    if (!parsed.success) {
      const paths = parsed.error.issues
        .map((issue) => issue.path.join(".") || "(root)")
        .slice(0, 10)
        .join(", ");
      const status = await safeFail(row, {
        code: "unknown_payload",
        retryable: false,
        message: `Payload failed validation at: ${paths}`,
      });
      if (status === "dead") await runOnDead(def, row, null, "unknown_payload");
      return;
    }
    const payload = parsed.data;

    const controller = new AbortController();
    const deadline = deps.now() + def.maxDurationMs;
    const timer = setTimeout(
      () => controller.abort(new TaskDeadlineError()),
      def.maxDurationMs,
    );

    let outcome: TaskHandlerResult;
    try {
      const handlerPromise = Promise.resolve().then(() =>
        def.handler({
          task: row,
          payload,
          admin: deps.admin,
          signal: controller.signal,
          deadline,
          log: tlog,
        }),
      );
      outcome = await raceWithAbort(handlerPromise, controller.signal);
      if (!isValidHandlerResult(outcome)) {
        throw new TaskError("internal_error", "Handler returned an invalid result.");
      }
    } catch (err) {
      clearTimeout(timer);

      if (err instanceof TaskError && err.code === "budget_exhausted") {
        // §13.4.5: budget_exhausted is a snooze, not a failure.
        await budgetSnooze(row, def);
        return;
      }

      const classified = classifyTaskError(err, {
        previousErrorCode: row.last_error_code,
        timedOut: controller.signal.aborted,
      });
      const status = await safeFail(row, classified);
      if (status === "dead") await runOnDead(def, row, payload, classified.code);
      return;
    } finally {
      clearTimeout(timer);
    }

    if (outcome.outcome === "succeeded") {
      await safeComplete(row, boundResult(outcome.result, tlog));
    } else {
      const seconds = clampSnoozeSeconds(outcome.seconds);
      const reason = REASON_PATTERN.test(outcome.reason) ? outcome.reason : "snoozed";
      if (await safeSnooze(row, seconds, reason)) summary.snoozed++;
    }
  };

  // ---- budget ------------------------------------------------------------

  let budgetWarned = false;
  const checkBudget = async (): Promise<BudgetStatus | "error"> => {
    try {
      const status = await checkGlobalAiBudget(
        (since) => store.getAiSpendSince(since),
        new Date(deps.now()),
        deps.budgetUsd,
      );
      if (status.exhausted && !budgetWarned) {
        budgetWarned = true;
        log("warn", "global daily AI budget exhausted; AI tasks snoozed to next UTC midnight", {
          spent_usd: Number(status.spentUsd.toFixed(4)),
          budget_usd: status.budgetUsd,
        });
      }
      return status;
    } catch (err) {
      log("warn", "AI budget check failed; not claiming AI kinds this round", {
        error: safeErrorName(err),
      });
      return "error";
    }
  };

  // ---- main loop ---------------------------------------------------------

  const inFlight = new Map<number, { taskClass: TaskClass; promise: Promise<void> }>();
  let nextSlotId = 0;
  const inFlightCount = (taskClass: TaskClass) => {
    let n = 0;
    for (const entry of inFlight.values()) if (entry.taskClass === taskClass) n++;
    return n;
  };

  const kindsByClass: Record<TaskClass, string[]> = {
    user: kindsForClass("user", registry),
    background: kindsForClass("background", registry),
  };

  for (;;) {
    const elapsed = deps.now() - startedAt;
    if (elapsed >= WORKER_SOFT_STOP_MS) {
      summary.stopReason = "soft_stop";
      break;
    }

    let claimedThisRound = 0;
    let claimFailed = false;
    let budget: BudgetStatus | "error" | null = null;

    for (const taskClass of CLASS_ORDER) {
      const cap = WORKER_CLASS_CAPS[taskClass];
      const free = cap - inFlightCount(taskClass);
      if (free <= 0) continue;

      const fitting = kindsByClass[taskClass].filter(
        (kind) => elapsed + registry[kind].maxDurationMs < WORKER_HARD_BUDGET_MS,
      );
      if (fitting.length === 0) continue;

      let claimKinds = fitting;
      let budgetExhausted = false;
      if (fitting.some((kind) => registry[kind].usesAi)) {
        budget ??= await checkBudget();
        if (budget === "error") {
          claimKinds = fitting.filter((kind) => !registry[kind].usesAi);
        } else if (budget.exhausted) {
          budgetExhausted = true;
        }
      }
      if (claimKinds.length === 0) continue;

      let rows: BackgroundTaskRow[];
      try {
        rows = await store.claim({
          workerId: invocationId,
          taskClass,
          kinds: claimKinds,
          maxRunning: cap,
          limit: free,
        });
      } catch (err) {
        log("error", "claim_tasks errored; stopping this tick", {
          task_class: taskClass,
          error: safeErrorName(err),
        });
        claimFailed = true;
        break;
      }

      for (const row of rows) {
        const def = getTaskDefinition(row.kind, registry);
        const work =
          budgetExhausted && def?.usesAi ? budgetSnooze(row, def) : runTask(row, def);
        const slotId = nextSlotId++;
        const promise = work
          .catch((err) => {
            // runTask/budgetSnooze already catch everything; belt and braces.
            log("error", "task run escaped its error handling", {
              task_id: row.id,
              kind: row.kind,
              error: safeErrorName(err),
            });
          })
          .finally(() => {
            inFlight.delete(slotId);
          });
        inFlight.set(slotId, { taskClass, promise });
        summary.claimed++;
      }
      claimedThisRound += rows.length;
    }

    if (claimFailed) {
      summary.stopReason = "claim_error";
      break;
    }

    if (claimedThisRound === 0) {
      if (inFlight.size === 0) {
        summary.stopReason = "idle";
        break;
      }
      await Promise.race(Array.from(inFlight.values(), (entry) => entry.promise));
    }
  }

  await Promise.allSettled(Array.from(inFlight.values(), (entry) => entry.promise));

  // ---- self-chaining -----------------------------------------------------

  if (summary.claimed > 0 && summary.stopReason !== "claim_error") {
    try {
      const more = await store.hasClaimableTasks({
        taskClass: "user",
        kinds: kindsByClass.user,
        now: new Date(deps.now()),
      });
      if (more) summary.kicked = await deps.kick();
    } catch (err) {
      log("warn", "self-kick check failed; cron tick is the backstop", {
        error: safeErrorName(err),
      });
    }
  }

  summary.durationMs = deps.now() - startedAt;
  const { invocationId: _omit, ...counts } = summary;
  void _omit;
  log("info", "tick finished", counts);
  return summary;
}

// ---- helpers ---------------------------------------------------------------

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // If we stop waiting, a late rejection from the handler must not surface
  // as an unhandled rejection.
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function isValidHandlerResult(value: unknown): value is TaskHandlerResult {
  if (!value || typeof value !== "object") return false;
  const v = value as { outcome?: unknown; seconds?: unknown; reason?: unknown };
  if (v.outcome === "succeeded") return true;
  return (
    v.outcome === "snooze" &&
    typeof v.seconds === "number" &&
    Number.isFinite(v.seconds) &&
    typeof v.reason === "string"
  );
}

export function clampSnoozeSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return MIN_SNOOZE_SECONDS;
  return Math.min(MAX_SNOOZE_SECONDS, Math.max(MIN_SNOOZE_SECONDS, Math.round(seconds)));
}

function boundResult(result: Json | undefined, log: TaskLogger): Json | null {
  if (result === undefined) return null;
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(result)).length;
  } catch {
    log.warn("task result is not JSON-serializable; dropped");
    return { result_dropped: "unserializable" };
  }
  if (size > MAX_RESULT_BYTES) {
    log.warn("task result exceeds size cap; dropped", { bytes: size });
    return { result_dropped: "too_large", bytes: size };
  }
  return result;
}
