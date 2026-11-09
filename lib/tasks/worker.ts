import { createAdminClient } from "@/lib/supabase/admin";
import {
  claimDeadTaskHooks,
  claimTasks,
  completeDeadTaskHook,
  completeTask,
  releaseDeadTaskHook,
  deferQueuedTasks,
  failTask,
  hasClaimableTasks,
  snoozeTask,
  type AdminClient,
  type BackgroundTaskRow,
} from "@/lib/supabase/queries/tasks";
import { getAiSpendSince } from "@/lib/supabase/queries/usage";
import {
  BUDGET_SNOOZE_MAX_JITTER_SECONDS,
  checkGlobalAiBudget,
  getGlobalDailyAiBudgetUsd,
  nextUtcMidnight,
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
 *   Over budget → AI kinds are NOT claimed; their claimable queued tasks are
 *   deferred in one SQL statement (`defer_queued_tasks`) to the next UTC
 *   midnight + jitter. Deferral never claims, so it can't consume an attempt,
 *   mark a task started, or disturb retry tracking, and a failed deferral
 *   just leaves the tasks queued. Check failed → AI kinds aren't claimed.
 * - Every PostgREST call the loop makes carries `AbortSignal.timeout(
 *   WORKER_DB_TIMEOUT_MS)`, so a hung call can't keep a tick alive until the
 *   platform's 300 s kill.
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

/** Per-call timeout for the loop's own PostgREST calls (claim/complete/...). */
export const WORKER_DB_TIMEOUT_MS = 15_000;

/** Max tasks deferred per class per tick when over the AI budget. */
export const BUDGET_DEFER_BATCH = 200;

/** Dead-task hook outbox (§13.4.5). */
export const DEAD_HOOK_BUDGET_MS = 20_000;
export const DEAD_HOOK_SWEEP_LIMIT = 20;
export const DEAD_HOOK_MAX_ATTEMPTS = 10;
/** Per-hook timeout; stays well under the SQL hook lock (120 s). */
export const DEAD_HOOK_TIMEOUT_MS = 15_000;
/** The sweep claims hooks in batches of this size (unrun rows are released). */
export const DEAD_HOOK_CLAIM_BATCH = 5;
/**
 * Worst-case time the fast path can take: claim + hook + completion, each
 * bounded by its own timeout. Skipped unless this much hard budget remains.
 */
export const DEAD_HOOK_FAST_PATH_RESERVE_MS = DEAD_HOOK_TIMEOUT_MS + 2 * WORKER_DB_TIMEOUT_MS;

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
  /** Budget deferral without claiming (`defer_queued_tasks`). */
  defer(args: {
    taskClass: TaskClass;
    kinds: string[];
    until: Date;
    maxJitterSeconds: number;
    limit: number;
  }): Promise<BackgroundTaskRow[]>;
  /** Dead-task hook outbox: lock pending hooks (`claim_dead_task_hooks`). */
  claimDeadHooks(args: {
    workerId: string;
    kinds: string[];
    limit: number;
    taskId?: string | null;
  }): Promise<BackgroundTaskRow[]>;
  /** Mark a hook handled (`complete_dead_task_hook`); false = fenced out. */
  completeDeadHook(args: { id: string; workerId: string; gaveUp: boolean }): Promise<boolean>;
  /** Give back a claimed-but-unrun hook (`release_dead_task_hook`). */
  releaseDeadHook(args: { id: string; workerId: string }): Promise<boolean>;
}

/**
 * The production store. Each call gets a fresh `AbortSignal.timeout`, so a
 * hung PostgREST request fails fast instead of pinning the tick. (Applied
 * per call rather than via a custom `fetch` on the shared admin client, so
 * `lib/supabase/admin.ts` behaves exactly as before for every other caller.)
 */
export function createWorkerStore(
  admin: AdminClient,
  options: { timeoutMs?: number } = {},
): WorkerStore {
  const timeoutMs = options.timeoutMs ?? WORKER_DB_TIMEOUT_MS;
  const opts = () => ({ signal: AbortSignal.timeout(timeoutMs) });
  return {
    claim: (args) => claimTasks(admin, args, opts()),
    complete: (id, workerId, result) => completeTask(admin, id, workerId, result, opts()),
    fail: (args) => failTask(admin, args, opts()),
    snooze: (args) => snoozeTask(admin, args, opts()),
    hasClaimableTasks: (args) => hasClaimableTasks(admin, args, opts()),
    getAiSpendSince: async (since) => {
      const rows = await getAiSpendSince(admin, since, opts());
      return rows.reduce((sum, row) => sum + row.costUsd, 0);
    },
    defer: (args) => deferQueuedTasks(admin, args, opts()),
    claimDeadHooks: (args) => claimDeadTaskHooks(admin, args, opts()),
    completeDeadHook: (args) => completeDeadTaskHook(admin, args, opts()),
    releaseDeadHook: (args) => releaseDeadTaskHook(admin, args, opts()),
  };
}

export type WorkerLogLevel = "info" | "warn" | "error";
export type WorkerLogSink = (
  level: WorkerLogLevel,
  message: string,
  fields: LogFields,
) => void;

/**
 * Lines logged with `alert: true` get a stable `[ALERT][worker]` prefix so
 * log-based alerting can match them (e.g. "onDead gave up").
 */
const consoleLogSink: WorkerLogSink = (level, message, fields) => {
  const prefix = fields.alert === true ? "[ALERT][worker]" : "[worker]";
  const line = `${prefix} ${message} ${JSON.stringify(fields)}`;
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
  /** Queued AI tasks deferred (not claimed) because the global budget is spent. */
  budgetDeferred: number;
  /** Running tasks snoozed because their handler threw `budget_exhausted`. */
  budgetSnoozed: number;
  /** complete/fail/snooze was a no-op because another worker now holds the task. */
  fencedOut: number;
  /** A complete/fail/snooze call itself errored; lease expiry will recover. */
  storeErrors: number;
  /** onDead hooks marked handled (including kinds with no hook). */
  deadHooksHandled: number;
  /** onDead hooks that threw and were left pending for a later tick. */
  deadHooksFailed: number;
  /** onDead hooks given up after DEAD_HOOK_MAX_ATTEMPTS (alerted). */
  deadHooksGaveUp: number;
  /** Hooks claimed by the sweep but released unrun (budget ran out). */
  deadHooksReleased: number;
  /** Fast-path deliveries skipped near the hard budget (sweep delivers). */
  deadHooksDeferredToSweep: number;
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
    budgetDeferred: 0,
    budgetSnoozed: 0,
    fencedOut: 0,
    storeErrors: 0,
    deadHooksHandled: 0,
    deadHooksFailed: 0,
    deadHooksGaveUp: 0,
    deadHooksReleased: 0,
    deadHooksDeferredToSweep: 0,
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

  /**
   * Snoozes a running task. Retried once on error: if both attempts fail,
   * the lease expires and the reclaim consumes an attempt, which is
   * acceptable only because snooze is used for tasks that genuinely ran.
   */
  const safeSnooze = async (row: BackgroundTaskRow, seconds: number, reason: string) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const ok = await store.snooze({ id: row.id, workerId: invocationId, seconds, reason });
        if (!ok) {
          summary.fencedOut++;
          taskLogger(row).warn("snooze_task fenced out (lease lost)");
        }
        return ok;
      } catch (err) {
        summary.storeErrors++;
        taskLogger(row).error(
          attempt === 1
            ? "snooze_task errored; retrying once"
            : "snooze_task errored twice; lease expiry will recover",
          { error: safeErrorName(err) },
        );
      }
    }
    return false;
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

  const parsePayload = (def: TaskDefinition, row: BackgroundTaskRow) =>
    def.payloadSchema.safeParse(row.payload);

  // ---- dead-task hook outbox (§13.4.5) -------------------------------------

  const completeHook = async (row: BackgroundTaskRow, gaveUp: boolean) => {
    try {
      const ok = await store.completeDeadHook({ id: row.id, workerId: invocationId, gaveUp });
      if (!ok) taskLogger(row).warn("complete_dead_task_hook fenced out (hook lock lost)");
      return ok;
    } catch (err) {
      summary.storeErrors++;
      taskLogger(row).error("complete_dead_task_hook errored; hook will be redelivered", {
        error: safeErrorName(err),
      });
      return false;
    }
  };

  /**
   * Runs one claimed hook. Success (or a kind without `onDead`) → handled.
   * Throw → left pending (the 120 s hook lock expires and a later tick
   * redelivers), unless this was attempt DEAD_HOOK_MAX_ATTEMPTS → give up
   * with an alertable log line.
   */
  const processDeadHook = async (row: BackgroundTaskRow) => {
    const def = getTaskDefinition(row.kind, registry);
    if (!def) return; // unreachable: hooks are only claimed for registered kinds
    const tlog = taskLogger(row);

    if (!def.onDead) {
      if (await completeHook(row, false)) summary.deadHooksHandled++;
      return;
    }

    const parsed = parsePayload(def, row);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new TaskDeadlineError()), DEAD_HOOK_TIMEOUT_MS);
    try {
      const hook = Promise.resolve().then(() =>
        def.onDead!({
          task: row,
          payload: parsed.success ? parsed.data : null,
          admin: deps.admin,
          errorCode: row.last_error_code ?? "internal_error",
          signal: controller.signal,
          log: tlog,
        }),
      );
      await raceWithAbort(hook, controller.signal);
    } catch (err) {
      clearTimeout(timer);
      const fields = { code: row.last_error_code, hook_attempt: row.on_dead_attempts, error: safeErrorName(err) };
      if (row.on_dead_attempts >= DEAD_HOOK_MAX_ATTEMPTS) {
        if (await completeHook(row, true)) summary.deadHooksGaveUp++;
        tlog.error("onDead gave up", { ...fields, alert: true });
      } else {
        summary.deadHooksFailed++;
        tlog.warn("onDead hook failed; will be redelivered", fields);
      }
      return;
    } finally {
      clearTimeout(timer);
    }
    if (await completeHook(row, false)) summary.deadHooksHandled++;
  };

  const claimHooks = async (args: { kinds: string[]; limit: number; taskId?: string }) => {
    try {
      return await store.claimDeadHooks({ workerId: invocationId, ...args });
    } catch (err) {
      log("warn", "claim_dead_task_hooks errored; hooks stay pending", { error: safeErrorName(err) });
      return [];
    }
  };

  /**
   * Gives back hooks this worker claimed but did not run: clears the lock
   * and refunds the attempt (`release_dead_task_hook`), so a hook that keeps
   * getting skipped behind slow ones never drifts toward the give-up limit.
   * A failed release only costs one inflated attempt and a 120 s wait.
   */
  const releaseHooks = async (rows: BackgroundTaskRow[]) => {
    for (const row of rows) {
      try {
        if (await store.releaseDeadHook({ id: row.id, workerId: invocationId })) {
          summary.deadHooksReleased++;
        } else {
          taskLogger(row).warn("release_dead_task_hook fenced out (hook lock lost)");
        }
      } catch (err) {
        summary.storeErrors++;
        taskLogger(row).error("release_dead_task_hook errored; lock expires in 120 s", {
          error: safeErrorName(err),
        });
      }
    }
  };

  /**
   * Sweep: every tick, before claiming tasks; up to DEAD_HOOK_BUDGET_MS and
   * DEAD_HOOK_SWEEP_LIMIT hooks. Claims in small batches so it never holds
   * many more rows than the remaining budget can run; whatever is still
   * unrun when the budget runs out is released, not left locked.
   */
  const sweepDeadHooks = async () => {
    const sweepStart = deps.now();
    const kinds = Object.keys(registry);
    let claimedTotal = 0;

    while (claimedTotal < DEAD_HOOK_SWEEP_LIMIT && deps.now() - sweepStart < DEAD_HOOK_BUDGET_MS) {
      const requested = Math.min(DEAD_HOOK_CLAIM_BATCH, DEAD_HOOK_SWEEP_LIMIT - claimedTotal);
      const batch = await claimHooks({ kinds, limit: requested });
      claimedTotal += batch.length;

      for (let i = 0; i < batch.length; i++) {
        if (deps.now() - sweepStart >= DEAD_HOOK_BUDGET_MS) {
          const unrun = batch.slice(i);
          log("warn", "dead-hook sweep budget used up; releasing unrun hooks", { released: unrun.length });
          await releaseHooks(unrun);
          return;
        }
        await processDeadHook(batch[i]);
      }

      if (batch.length < requested) return; // nothing more pending (or claim failed)
    }
  };

  /**
   * Fast path: right after this worker's own fail_task returned 'dead'.
   * Skipped when the tick is too close to its hard budget to fit a claim, a
   * hook and a completion (the next tick's sweep delivers it instead), so
   * this latency optimization can never push the invocation past the
   * platform's 300 s limit.
   */
  const deliverDeadHookNow = async (row: BackgroundTaskRow) => {
    if (deps.now() - startedAt + DEAD_HOOK_FAST_PATH_RESERVE_MS >= WORKER_HARD_BUDGET_MS) {
      summary.deadHooksDeferredToSweep++;
      taskLogger(row).info("fast-path onDead skipped near the hard budget; next sweep delivers it");
      return;
    }
    const rows = await claimHooks({ kinds: [row.kind], limit: 1, taskId: row.id });
    for (const claimed of rows) await processDeadHook(claimed);
  };

  // ---- budget delay hooks ------------------------------------------------

  const runOnBudgetDelayed = async (row: BackgroundTaskRow, def: TaskDefinition | undefined) => {
    if (!def?.onBudgetDelayed) return;
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
  };

  /** A running handler threw `budget_exhausted` (e.g. ingest budget). */
  const budgetSnoozeRunning = async (row: BackgroundTaskRow, def: TaskDefinition) => {
    const seconds = secondsUntilBudgetReset(new Date(deps.now()), deps.random);
    if (!(await safeSnooze(row, seconds, "budget_exhausted"))) return;
    summary.budgetSnoozed++;
    await runOnBudgetDelayed(row, def);
  };

  /** Over the global budget: defer (never claim) queued AI tasks of a class. */
  const deferredClasses = new Set<TaskClass>();
  const deferAiTasks = async (taskClass: TaskClass, aiKinds: string[]) => {
    if (deferredClasses.has(taskClass) || aiKinds.length === 0) return;
    deferredClasses.add(taskClass); // once per class per tick; next tick continues
    let rows: BackgroundTaskRow[];
    try {
      rows = await store.defer({
        taskClass,
        kinds: aiKinds,
        until: nextUtcMidnight(new Date(deps.now())),
        maxJitterSeconds: BUDGET_SNOOZE_MAX_JITTER_SECONDS,
        limit: BUDGET_DEFER_BATCH,
      });
    } catch (err) {
      // Nothing was claimed, so nothing is lost: the tasks stay queued and
      // the next tick (still over budget) tries again.
      log("warn", "defer_queued_tasks errored; AI tasks stay queued", {
        task_class: taskClass,
        error: safeErrorName(err),
      });
      return;
    }
    summary.budgetDeferred += rows.length;
    for (const row of rows) {
      await runOnBudgetDelayed(row, getTaskDefinition(row.kind, registry));
    }
  };

  // ---- per-task execution ------------------------------------------------

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
      if (status === "dead") await deliverDeadHookNow(row);
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
        await budgetSnoozeRunning(row, def);
        return;
      }

      const classified = classifyTaskError(err, {
        previousErrorCode: row.last_error_code,
        timedOut: controller.signal.aborted,
      });
      const status = await safeFail(row, classified);
      if (status === "dead") await deliverDeadHookNow(row);
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
        log("warn", "global daily AI budget exhausted; AI tasks deferred to next UTC midnight", {
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

  // Deliver pending onDead hooks first (outbox sweep, §13.4.5). This covers
  // tasks killed in SQL (lease_expired, stale-lease sweep) and fast-path
  // deliveries interrupted by a dying worker.
  if (deps.now() - startedAt < WORKER_SOFT_STOP_MS) {
    await sweepDeadHooks();
  }

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
      const aiKinds = fitting.filter((kind) => registry[kind].usesAi);
      if (aiKinds.length > 0) {
        budget ??= await checkBudget();
        if (budget === "error" || budget.exhausted) {
          // Fail closed / over budget: never claim AI kinds.
          claimKinds = fitting.filter((kind) => !registry[kind].usesAi);
          if (budget !== "error") await deferAiTasks(taskClass, aiKinds);
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
        const work = runTask(row, getTaskDefinition(row.kind, registry));
        const slotId = nextSlotId++;
        const promise = work
          .catch((err) => {
            // runTask already catches everything; belt and braces.
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
