import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { TaskError } from "@/lib/tasks/errors";
import { taskRegistry, type TaskRegistry } from "@/lib/tasks/registry";
import type { BackgroundTaskRow, TaskDefinition, TaskHandlerResult } from "@/lib/tasks/types";
import {
  runWorkerTick,
  WORKER_HARD_BUDGET_MS,
  WORKER_MAX_RUNNING_BACKGROUND,
  WORKER_MAX_RUNNING_USER,
  WORKER_SOFT_STOP_MS,
  type WorkerStore,
} from "@/lib/tasks/worker";
import type { Json } from "@/types/database";

/**
 * In-memory WorkerStore that mirrors the SQL semantics of 0007's
 * claim_tasks / complete_task / fail_task / snooze_task / defer_queued_tasks /
 * claim_dead_task_hooks / complete_dead_task_hook (the SQL itself is
 * validated separately against real Postgres; pgTAP lands in M1.3):
 * - caps count live leases in the class across ALL workers;
 * - expired leases are reclaimable, and dead-lettered (lease_expired) at
 *   max attempts;
 * - complete/fail/snooze are fenced on locked_by + status = running;
 * - claim is atomic (JS is single-threaded, standing in for the advisory lock).
 */
class FakeStore implements WorkerStore {
  rows: BackgroundTaskRow[] = [];
  spendUsd = 0;
  spendError: Error | null = null;
  claimError: Error | null = null;
  completeError: Error | null = null;
  deferError: Error | null = null;
  hookClaimError: Error | null = null;
  deferCalls: { taskClass: string; kinds: string[]; until: Date; maxJitterSeconds: number; limit: number }[] = [];
  claimCalls: { workerId: string; taskClass: string; kinds: string[]; maxRunning: number; limit: number }[] = [];
  maxRunningSeen: Record<string, number> = { user: 0, background: 0 };
  private seq = 0;

  constructor(private readonly clock: () => number) {}

  add(row: Partial<BackgroundTaskRow> & { kind: string; task_class: BackgroundTaskRow["task_class"] }) {
    const now = new Date(this.clock()).toISOString();
    const full: BackgroundTaskRow = {
      id: `task-${++this.seq}`,
      status: "queued",
      priority: 0,
      user_id: null,
      correlation_id: null,
      parent_task_id: null,
      payload: {},
      dedupe_key: null,
      attempts: 0,
      max_attempts: 3,
      run_after: now,
      lease_seconds: 300,
      locked_by: null,
      locked_until: null,
      started_at: null,
      finished_at: null,
      last_error_code: null,
      last_error_message: null,
      result: null,
      on_dead_handled_at: null,
      on_dead_attempts: 0,
      on_dead_locked_by: null,
      on_dead_locked_until: null,
      created_at: now,
      updated_at: now,
      ...row,
    };
    this.rows.push(full);
    return full;
  }

  get(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  }

  private t(iso: string | null) {
    return iso ? Date.parse(iso) : Number.NaN;
  }

  private liveRunning(taskClass: string, now: number) {
    return this.rows.filter(
      (r) => r.task_class === taskClass && r.status === "running" && this.t(r.locked_until) > now,
    ).length;
  }

  async claim(args: { workerId: string; taskClass: BackgroundTaskRow["task_class"]; kinds: string[]; maxRunning: number; limit: number }) {
    this.claimCalls.push({ ...args, kinds: [...args.kinds] });
    if (this.claimError) throw this.claimError;
    const now = this.clock();
    const iso = new Date(now).toISOString();

    for (const r of this.rows) {
      if (
        r.task_class === args.taskClass && args.kinds.includes(r.kind) && r.status === "running" &&
        this.t(r.locked_until) <= now && r.attempts >= r.max_attempts
      ) {
        Object.assign(r, { status: "dead", last_error_code: "lease_expired", locked_until: null, finished_at: iso });
      }
    }

    const slots = Math.min(args.limit, args.maxRunning - this.liveRunning(args.taskClass, now));
    if (slots <= 0) return [];

    const candidates = this.rows
      .filter(
        (r) =>
          r.task_class === args.taskClass && args.kinds.includes(r.kind) &&
          ((r.status === "queued" && this.t(r.run_after) <= now) ||
            (r.status === "running" && this.t(r.locked_until) <= now && r.attempts < r.max_attempts)),
      )
      .sort((a, b) => b.priority - a.priority || this.t(a.run_after) - this.t(b.run_after))
      .slice(0, slots);

    for (const r of candidates) {
      Object.assign(r, {
        status: "running",
        attempts: r.attempts + 1,
        locked_by: args.workerId,
        locked_until: new Date(now + r.lease_seconds * 1000).toISOString(),
        started_at: r.started_at ?? iso,
      });
    }
    this.maxRunningSeen[args.taskClass] = Math.max(
      this.maxRunningSeen[args.taskClass],
      this.liveRunning(args.taskClass, now),
    );
    // Return snapshots, like PostgREST does.
    return candidates.map((r) => ({ ...r }));
  }

  private held(id: string, workerId: string) {
    const r = this.rows.find((x) => x.id === id);
    return r && r.locked_by === workerId && r.status === "running" ? r : null;
  }

  async complete(id: string, workerId: string, result: Json | null) {
    if (this.completeError) throw this.completeError;
    const r = this.held(id, workerId);
    if (!r) return false;
    Object.assign(r, { status: "succeeded", result, locked_until: null, finished_at: new Date(this.clock()).toISOString() });
    return true;
  }

  async fail(args: { id: string; workerId: string; errorCode: string; errorMessage: string | null; retryable: boolean; retryDelaySeconds: number }) {
    const r = this.held(args.id, args.workerId);
    if (!r) return null;
    const now = this.clock();
    Object.assign(r, { last_error_code: args.errorCode, last_error_message: args.errorMessage, locked_until: null });
    if (args.retryable && r.attempts < r.max_attempts) {
      Object.assign(r, {
        status: "queued",
        locked_by: null,
        run_after: new Date(now + Math.max(0, args.retryDelaySeconds) * 1000).toISOString(),
      });
      return "queued" as const;
    }
    Object.assign(r, { status: "dead", finished_at: new Date(now).toISOString() });
    return "dead" as const;
  }

  async snooze(args: { id: string; workerId: string; seconds: number; reason: string }) {
    const r = this.held(args.id, args.workerId);
    if (!r) return false;
    Object.assign(r, {
      status: "queued",
      attempts: Math.max(r.attempts - 1, 0),
      run_after: new Date(this.clock() + args.seconds * 1000).toISOString(),
      locked_by: null,
      locked_until: null,
      // Mirrors 0007: a prior attempt's real error code is preserved.
      last_error_code: r.last_error_code ?? args.reason,
    });
    return true;
  }

  async defer(args: { taskClass: BackgroundTaskRow["task_class"]; kinds: string[]; until: Date; maxJitterSeconds: number; limit: number }) {
    this.deferCalls.push({ ...args, kinds: [...args.kinds] });
    if (this.deferError) throw this.deferError;
    const now = this.clock();
    const due = this.rows
      .filter((r) => r.task_class === args.taskClass && args.kinds.includes(r.kind) && r.status === "queued" && this.t(r.run_after) <= now)
      .slice(0, args.limit);
    for (const r of due) {
      // No claim: only run_after moves (jitter fixed at half for determinism).
      r.run_after = new Date(Math.max(args.until.getTime(), now) + (args.maxJitterSeconds / 2) * 1000).toISOString();
    }
    return due.map((r) => ({ ...r }));
  }

  async claimDeadHooks(args: { workerId: string; kinds: string[]; limit: number; taskId?: string | null }) {
    if (this.hookClaimError) throw this.hookClaimError;
    const now = this.clock();
    const pending = this.rows
      .filter(
        (r) => r.status === "dead" && r.on_dead_handled_at === null && args.kinds.includes(r.kind) &&
          (r.on_dead_locked_until === null || this.t(r.on_dead_locked_until) <= now) &&
          (!args.taskId || r.id === args.taskId),
      )
      .sort((a, b) => this.t(a.finished_at) - this.t(b.finished_at))
      .slice(0, args.limit);
    for (const r of pending) {
      Object.assign(r, {
        on_dead_locked_by: args.workerId,
        on_dead_locked_until: new Date(now + 120_000).toISOString(),
        on_dead_attempts: r.on_dead_attempts + 1,
      });
    }
    return pending.map((r) => ({ ...r }));
  }

  async completeDeadHook(args: { id: string; workerId: string; gaveUp: boolean }) {
    const r = this.rows.find((x) => x.id === args.id);
    if (!r || r.status !== "dead" || r.on_dead_handled_at !== null || r.on_dead_locked_by !== args.workerId) return false;
    Object.assign(r, {
      on_dead_handled_at: new Date(this.clock()).toISOString(),
      on_dead_locked_by: null,
      on_dead_locked_until: null,
      last_error_message: args.gaveUp ? `onDead hook gave up after ${r.on_dead_attempts} attempts` : r.last_error_message,
    });
    return true;
  }

  async releaseDeadHook(args: { id: string; workerId: string }) {
    const r = this.rows.find((x) => x.id === args.id);
    if (!r || r.status !== "dead" || r.on_dead_handled_at !== null || r.on_dead_locked_by !== args.workerId) return false;
    Object.assign(r, {
      on_dead_locked_by: null,
      on_dead_locked_until: null,
      on_dead_attempts: Math.max(r.on_dead_attempts - 1, 0),
    });
    return true;
  }

  async hasClaimableTasks(args: { taskClass: string; kinds: string[]; now: Date }) {
    return this.rows.some(
      (r) => r.status === "queued" && r.task_class === args.taskClass && args.kinds.includes(r.kind) &&
        this.t(r.run_after) <= args.now.getTime(),
    );
  }

  async getAiSpendSince() {
    if (this.spendError) throw this.spendError;
    return this.spendUsd;
  }
}

/** A clock that tracks real time but can be jumped forward. */
function makeClock(start = Date.parse("2026-11-04T12:00:00.000Z")) {
  const realStart = Date.now();
  let offset = 0;
  return {
    now: () => start + (Date.now() - realStart) + offset,
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

function def(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    class: "user",
    priority: 0,
    maxAttempts: 3,
    leaseSeconds: 120,
    maxDurationMs: 60_000,
    usesAi: false,
    payloadSchema: z.object({}).loose(),
    handler: async () => ({ outcome: "succeeded" }),
    ...overrides,
  };
}

function setup(registry: TaskRegistry, opts: { budgetUsd?: number } = {}) {
  const clock = makeClock();
  const store = new FakeStore(clock.now);
  const kick = vi.fn().mockResolvedValue(true);
  const logs: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  let n = 0;
  const tick = (startedAt = clock.now()) =>
    runWorkerTick(
      { invocationId: `worker-${++n}`, startedAt },
      {
        admin: {} as never,
        store,
        registry,
        now: clock.now,
        random: () => 0.5,
        kick,
        budgetUsd: opts.budgetUsd ?? 15,
        logSink: (level, message, fields) => logs.push({ level, message, fields }),
      },
    );
  return { clock, store, kick, logs, tick };
}

/** A gate handlers can await; resolves all waiters when opened. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const tickMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runWorkerTick — basics", () => {
  it("processes a maintenance.noop task to succeeded (real registry entry)", async () => {
    const { store, tick } = setup(taskRegistry);
    const row = store.add({ kind: "maintenance.noop", task_class: "background" });

    const summary = await tick();

    expect(store.get(row.id)).toMatchObject({ status: "succeeded", attempts: 1, result: { noop: true, attempt: 1 } });
    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, dead: 0, stopReason: "idle" });
  });

  it("exits immediately (idle) on an empty queue without kicking", async () => {
    const { store, kick, tick } = setup(taskRegistry);
    const summary = await tick();
    expect(summary).toMatchObject({ claimed: 0, stopReason: "idle", kicked: false });
    expect(kick).not.toHaveBeenCalled();
    expect(store.claimCalls.length).toBeGreaterThan(0);
  });

  it("leaves unknown kinds queued (never claims, never dead-letters them)", async () => {
    const { store, tick } = setup(taskRegistry);
    const future = store.add({ kind: "future.kind_from_newer_code", task_class: "user" });
    const futureBg = store.add({ kind: "future.other", task_class: "background" });

    await tick();

    for (const id of [future.id, futureBg.id]) {
      expect(store.get(id)).toMatchObject({ status: "queued", attempts: 0, locked_by: null });
    }
    for (const call of store.claimCalls) {
      expect(call.kinds).not.toContain("future.kind_from_newer_code");
    }
  });

  it("claims user before background on every iteration", async () => {
    const { store, tick } = setup({
      "a.user": def({ class: "user" }),
      "a.bg": def({ class: "background" }),
    });
    store.add({ kind: "a.bg", task_class: "background" });
    store.add({ kind: "a.user", task_class: "user" });
    await tick();
    expect(store.claimCalls[0].taskClass).toBe("user");
    expect(store.claimCalls[1].taskClass).toBe("background");
  });
});

describe("runWorkerTick — concurrency caps", () => {
  it("never exceeds the class caps, even across two concurrent ticks", async () => {
    const g = gate();
    let running = 0;
    let peakUser = 0;
    let peakBg = 0;
    const blocking = (cls: "user" | "background") =>
      def({
        class: cls,
        handler: async () => {
          running++;
          if (cls === "user") peakUser = Math.max(peakUser, running);
          await g.promise;
          running--;
          return { outcome: "succeeded" };
        },
      });
    const registry = { "x.user": blocking("user"), "x.bg": def({ class: "background", handler: async () => {
      peakBg++;
      await g.promise;
      return { outcome: "succeeded" } as TaskHandlerResult;
    } }) };
    const { store, tick } = setup(registry);
    for (let i = 0; i < 10; i++) store.add({ kind: "x.user", task_class: "user" });
    for (let i = 0; i < 5; i++) store.add({ kind: "x.bg", task_class: "background" });

    const t1 = tick();
    const t2 = tick();
    await tickMs(20);

    // While blocked: global caps hold across both invocations.
    const live = (cls: string) => store.rows.filter((r) => r.task_class === cls && r.status === "running").length;
    expect(live("user")).toBe(WORKER_MAX_RUNNING_USER);
    expect(live("background")).toBe(WORKER_MAX_RUNNING_BACKGROUND);
    expect(peakUser).toBeLessThanOrEqual(WORKER_MAX_RUNNING_USER);
    expect(peakBg).toBeLessThanOrEqual(WORKER_MAX_RUNNING_BACKGROUND);

    g.open();
    const [s1, s2] = await Promise.all([t1, t2]);

    expect(store.maxRunningSeen.user).toBeLessThanOrEqual(WORKER_MAX_RUNNING_USER);
    expect(store.maxRunningSeen.background).toBeLessThanOrEqual(WORKER_MAX_RUNNING_BACKGROUND);
    expect(s1.claimed + s2.claimed).toBe(15);
    expect(store.rows.every((r) => r.status === "succeeded")).toBe(true);
    // Every claim asked for the global cap as p_max_running.
    for (const call of store.claimCalls) {
      expect(call.maxRunning).toBe(call.taskClass === "user" ? WORKER_MAX_RUNNING_USER : WORKER_MAX_RUNNING_BACKGROUND);
      expect(call.limit).toBeGreaterThan(0);
      expect(call.limit).toBeLessThanOrEqual(call.maxRunning);
    }
  });

  it("refills slots as tasks finish (claim → run → claim more)", async () => {
    const { store, tick } = setup({ "q.user": def({ handler: async () => {
      await tickMs(2);
      return { outcome: "succeeded" };
    } }) });
    for (let i = 0; i < 9; i++) store.add({ kind: "q.user", task_class: "user" });
    const summary = await tick();
    expect(summary.succeeded).toBe(9);
    expect(store.claimCalls.filter((c) => c.taskClass === "user").length).toBeGreaterThan(1);
  });

  it("an expired lease from a dead worker doesn't count toward the cap and is reclaimed", async () => {
    const { store, clock, tick } = setup({ "z.user": def() });
    const past = new Date(clock.now() - 1000).toISOString();
    const zombie = store.add({ kind: "z.user", task_class: "user", status: "running", attempts: 1, locked_by: "dead-worker", locked_until: past });
    await tick();
    expect(store.get(zombie.id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });
});

describe("runWorkerTick — retries, backoff, dead letters", () => {
  it("forced-failure noop retries with backoff (30 s, 2 min) and ends dead", async () => {
    const { store, clock, tick } = setup(taskRegistry);
    const row = store.add({
      kind: "maintenance.noop",
      task_class: "background",
      max_attempts: 3,
      lease_seconds: 60,
      payload: { force_fail: true },
    });

    await tick();
    let r = store.get(row.id);
    expect(r).toMatchObject({ status: "queued", attempts: 1, last_error_code: "internal_error", locked_by: null });
    expect(Date.parse(r.run_after) - clock.now()).toBeGreaterThan(29_000); // ~30 s (random 0.5 → ×1.0)

    // Not claimable until the backoff elapses.
    await tick();
    expect(store.get(row.id).attempts).toBe(1);

    clock.advance(31_000);
    await tick();
    r = store.get(row.id);
    expect(r).toMatchObject({ status: "queued", attempts: 2 });
    expect(Date.parse(r.run_after) - clock.now()).toBeGreaterThan(119_000); // ~2 min

    clock.advance(121_000);
    await tick();
    expect(store.get(row.id)).toMatchObject({
      status: "dead",
      attempts: 3,
      last_error_code: "internal_error",
      last_error_message: "Forced failure (maintenance.noop test task).",
    });
  });

  it("non-retryable errors go straight to dead and fire onDead once", async () => {
    const onDead = vi.fn().mockResolvedValue(undefined);
    const { store, tick } = setup({
      "r.user": def({
        handler: async () => {
          throw new TaskError("ownership_mismatch", "Report owner differs from task owner.");
        },
        onDead,
      }),
    });
    const row = store.add({ kind: "r.user", task_class: "user", payload: { report_id: "r1" } });

    const summary = await tick();

    expect(store.get(row.id)).toMatchObject({ status: "dead", attempts: 1, last_error_code: "ownership_mismatch" });
    expect(summary.dead).toBe(1);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead.mock.calls[0][0]).toMatchObject({ errorCode: "ownership_mismatch", payload: { report_id: "r1" } });
  });

  it("ai_invalid_output gets one more try, then dead", async () => {
    const invalid = Object.assign(new Error("schema mismatch"), { name: "ClaudeInvalidOutputError" });
    const { store, clock, tick } = setup({
      "ai.user": def({ maxAttempts: 5, handler: async () => {
        throw invalid;
      } }),
    });
    const row = store.add({ kind: "ai.user", task_class: "user", max_attempts: 5 });

    await tick();
    expect(store.get(row.id)).toMatchObject({ status: "queued", last_error_code: "ai_invalid_output" });
    clock.advance(60_000);
    await tick();
    expect(store.get(row.id)).toMatchObject({ status: "dead", attempts: 2, last_error_code: "ai_invalid_output" });
  });

  it("unknown_payload: dead without running the handler; onDead gets payload null", async () => {
    const handler = vi.fn();
    const onDead = vi.fn().mockResolvedValue(undefined);
    const { store, tick } = setup({
      "p.user": def({ payloadSchema: z.strictObject({ report_id: z.uuid() }), handler, onDead }),
    });
    const row = store.add({ kind: "p.user", task_class: "user", payload: { report_id: "Jane Doe" } });

    await tick();

    expect(handler).not.toHaveBeenCalled();
    const r = store.get(row.id);
    expect(r).toMatchObject({ status: "dead", last_error_code: "unknown_payload" });
    expect(r.last_error_message).toBe("Payload failed validation at: report_id");
    expect(onDead.mock.calls[0][0]).toMatchObject({ payload: null, errorCode: "unknown_payload" });
  });

  it("never persists a raw (non-TaskError) error message", async () => {
    const { store, tick } = setup({
      "e.user": def({ handler: async () => {
        throw new Error("Jane Doe, 555-0100, jane@example.com");
      } }),
    });
    const row = store.add({ kind: "e.user", task_class: "user" });
    await tick();
    expect(store.get(row.id).last_error_message).toBe("Unhandled Error");
  });

  it("aborts a handler at maxDurationMs even if it ignores the signal", async () => {
    let sawAbort = false;
    const { store, tick } = setup({
      "slow.user": def({
        maxDurationMs: 30,
        handler: (ctx) => {
          ctx.signal.addEventListener("abort", () => {
            sawAbort = true;
          });
          return new Promise<TaskHandlerResult>(() => {}); // never settles
        },
      }),
    });
    const row = store.add({ kind: "slow.user", task_class: "user" });

    await tick();

    expect(sawAbort).toBe(true);
    expect(store.get(row.id)).toMatchObject({
      status: "queued",
      last_error_code: "internal_error",
      last_error_message: "Task exceeded its time budget (maxDurationMs).",
    });
  });

  it("treats an invalid handler result as a retryable internal_error", async () => {
    const { store, tick } = setup({ "bad.user": def({ handler: async () => ({ nope: true }) as never }) });
    const row = store.add({ kind: "bad.user", task_class: "user" });
    await tick();
    expect(store.get(row.id)).toMatchObject({ status: "queued", last_error_message: "Handler returned an invalid result." });
  });

  it("caps oversized results instead of storing them", async () => {
    const { store, tick } = setup({ "big.user": def({ handler: async () => ({ outcome: "succeeded", result: { blob: "x".repeat(10_000) } }) }) });
    const row = store.add({ kind: "big.user", task_class: "user" });
    await tick();
    expect(store.get(row.id).result).toMatchObject({ result_dropped: "too_large" });
  });
});

describe("runWorkerTick — snooze and fencing", () => {
  it("handler snooze re-queues without consuming an attempt (clamped ≥ 5 s)", async () => {
    const { store, clock, tick } = setup({ "s.user": def({ handler: async () => ({ outcome: "snooze", seconds: 0, reason: "batch_not_ready" }) }) });
    const row = store.add({ kind: "s.user", task_class: "user" });

    const summary = await tick();

    const r = store.get(row.id);
    expect(r).toMatchObject({ status: "queued", attempts: 0, last_error_code: "batch_not_ready" });
    expect(Date.parse(r.run_after) - clock.now()).toBeGreaterThan(4_000);
    expect(summary.snoozed).toBe(1);
  });

  it("snooze keeps a prior attempt's error code (retry tracking survives)", async () => {
    const invalid = Object.assign(new Error("x"), { name: "ClaudeInvalidOutputError" });
    let calls = 0;
    const { store, clock, tick } = setup({
      "m.user": def({
        maxAttempts: 5,
        handler: async () => {
          calls++;
          if (calls === 2) return { outcome: "snooze", seconds: 10, reason: "batch_not_ready" };
          throw invalid;
        },
      }),
    });
    const row = store.add({ kind: "m.user", task_class: "user", max_attempts: 5 });

    await tick(); // attempt 1: invalid output -> queued
    clock.advance(60_000);
    await tick(); // attempt 2: snooze (keeps ai_invalid_output)
    expect(store.get(row.id).last_error_code).toBe("ai_invalid_output");
    clock.advance(20_000);
    await tick(); // attempt 2 again: invalid output twice in a row -> dead
    expect(store.get(row.id)).toMatchObject({ status: "dead", attempts: 2 });
  });

  it("noop snooze_seconds snoozes once, then succeeds on the next claim", async () => {
    const { store, clock, tick } = setup(taskRegistry);
    const row = store.add({ kind: "maintenance.noop", task_class: "background", payload: { snooze_seconds: 30 } });
    await tick();
    expect(store.get(row.id)).toMatchObject({ status: "queued", attempts: 0 });
    clock.advance(31_000);
    await tick();
    expect(store.get(row.id)).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("a zombie worker whose lease was taken over cannot complete the task", async () => {
    const ref: { store?: FakeStore } = {};
    const { store, tick } = setup({
      "f.user": def({
        handler: async ({ task }) => {
          // Another worker reclaims the task mid-run (lease expired).
          Object.assign(ref.store!.get(task.id), { locked_by: "other-worker", attempts: 2 });
          return { outcome: "succeeded" };
        },
      }),
    });
    ref.store = store;
    const row = store.add({ kind: "f.user", task_class: "user" });

    const summary = await tick();

    expect(summary).toMatchObject({ succeeded: 0, fencedOut: 1 });
    expect(store.get(row.id)).toMatchObject({ status: "running", locked_by: "other-worker" });
  });

  it("a store error while completing never crashes the tick", async () => {
    const { store, tick } = setup({ "c.user": def() });
    store.completeError = new Error("network");
    const row = store.add({ kind: "c.user", task_class: "user" });
    const summary = await tick();
    expect(summary.storeErrors).toBe(1);
    expect(store.get(row.id).status).toBe("running"); // lease expiry will recover it
  });
});

describe("runWorkerTick — time budget", () => {
  it("only claims kinds that still fit: elapsed + maxDurationMs < hard budget", async () => {
    const { store, clock, tick } = setup({
      "long.user": def({ maxDurationMs: 200_000, leaseSeconds: 270 }),
      "short.user": def({ maxDurationMs: 10_000 }),
    });
    store.add({ kind: "long.user", task_class: "user" });
    const short = store.add({ kind: "short.user", task_class: "user" });

    const startedAt = clock.now() - 100_000; // 100 s into the invocation
    await tick(startedAt);

    expect(store.claimCalls[0].kinds).toEqual(["short.user"]);
    expect(store.get(short.id).status).toBe("succeeded");
    expect(store.rows.find((r) => r.kind === "long.user")?.status).toBe("queued");
    expect(100_000 + 200_000).toBeGreaterThanOrEqual(WORKER_HARD_BUDGET_MS);
  });

  it("stops claiming at the soft stop", async () => {
    const { store, clock, tick } = setup({ "q.user": def() });
    store.add({ kind: "q.user", task_class: "user" });
    const summary = await tick(clock.now() - WORKER_SOFT_STOP_MS);
    expect(summary).toMatchObject({ claimed: 0, stopReason: "soft_stop" });
    expect(store.claimCalls).toHaveLength(0);
  });

  it("stops the tick on a claim error without kicking", async () => {
    const { store, kick, tick } = setup({ "q.user": def() });
    store.claimError = new Error("db down");
    const summary = await tick();
    expect(summary.stopReason).toBe("claim_error");
    expect(kick).not.toHaveBeenCalled();
  });
});

describe("runWorkerTick — global AI budget (§13.9.4)", () => {
  it("over budget: never claims AI kinds; defers them past UTC midnight without using an attempt", async () => {
    const handler = vi.fn();
    const onBudgetDelayed = vi.fn().mockResolvedValue(undefined);
    const { store, logs, tick } = setup(
      { "ai.user": def({ usesAi: true, handler, onBudgetDelayed }), "plain.user": def() },
      { budgetUsd: 15 },
    );
    store.spendUsd = 15.01;
    // A retry that previously returned invalid output: its tracking must survive.
    const ai = store.add({ kind: "ai.user", task_class: "user", attempts: 1, last_error_code: "ai_invalid_output", payload: { report_id: "r1" } });
    const plain = store.add({ kind: "plain.user", task_class: "user" });

    const summary = await tick();

    expect(handler).not.toHaveBeenCalled();
    for (const call of store.claimCalls) expect(call.kinds).not.toContain("ai.user");
    const r = store.get(ai.id);
    expect(r).toMatchObject({
      status: "queued",
      attempts: 1, // untouched: never claimed
      started_at: null, // never marked started
      locked_by: null,
      last_error_code: "ai_invalid_output", // retry tracking preserved
    });
    expect(Date.parse(r.run_after)).toBeGreaterThanOrEqual(Date.parse("2026-11-05T00:00:00.000Z"));
    expect(Date.parse(r.run_after)).toBeLessThanOrEqual(Date.parse("2026-11-05T00:15:00.000Z"));
    expect(store.deferCalls).toHaveLength(1); // once per class per tick
    expect(store.deferCalls[0]).toMatchObject({ taskClass: "user", kinds: ["ai.user"], maxJitterSeconds: 900, limit: 200 });
    expect(store.deferCalls[0].until.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(onBudgetDelayed).toHaveBeenCalledTimes(1);
    expect(onBudgetDelayed.mock.calls[0][0]).toMatchObject({ payload: { report_id: "r1" } });
    expect(store.get(plain.id).status).toBe("succeeded");
    expect(summary).toMatchObject({ budgetDeferred: 1, budgetSnoozed: 0 });
    expect(logs.filter((l) => l.message.includes("budget exhausted"))).toHaveLength(1);
  });

  it("over budget: a failing deferral leaves AI tasks queued and untouched (nothing lost)", async () => {
    const { store, logs, tick } = setup({ "ai.user": def({ usesAi: true }) });
    store.spendUsd = 99;
    store.deferError = new Error("timeout");
    const ai = store.add({ kind: "ai.user", task_class: "user" });
    const before = store.get(ai.id).run_after;

    await tick();

    expect(store.get(ai.id)).toMatchObject({ status: "queued", attempts: 0, run_after: before, started_at: null });
    expect(logs.some((l) => l.message.includes("defer_queued_tasks errored"))).toBe(true);
  });

  it("under budget: AI tasks run normally", async () => {
    const { store, tick } = setup({ "ai.user": def({ usesAi: true }) });
    store.spendUsd = 14.99;
    const ai = store.add({ kind: "ai.user", task_class: "user" });
    await tick();
    expect(store.get(ai.id).status).toBe("succeeded");
  });

  it("budget check failure: AI kinds are not claimed (fail closed), others still run", async () => {
    const { store, tick } = setup({ "ai.user": def({ usesAi: true }), "plain.user": def() });
    store.spendError = new Error("rpc failed");
    const ai = store.add({ kind: "ai.user", task_class: "user" });
    const plain = store.add({ kind: "plain.user", task_class: "user" });

    await tick();

    expect(store.get(ai.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(store.get(plain.id).status).toBe("succeeded");
    for (const call of store.claimCalls) expect(call.kinds).not.toContain("ai.user");
  });

  it("a handler throwing budget_exhausted is snoozed, not failed", async () => {
    const { store, tick } = setup({ "ing.bg": def({ class: "background", handler: async () => {
      throw new TaskError("budget_exhausted");
    } }) });
    const row = store.add({ kind: "ing.bg", task_class: "background" });
    const summary = await tick();
    expect(store.get(row.id)).toMatchObject({ status: "queued", attempts: 0, last_error_code: "budget_exhausted" });
    expect(summary.budgetSnoozed).toBe(1);
  });

  it("a failed snooze is retried once", async () => {
    const { store, tick } = setup({ "s.user": def({ handler: async () => ({ outcome: "snooze", seconds: 30, reason: "batch_not_ready" }) }) });
    const row = store.add({ kind: "s.user", task_class: "user" });
    const real = store.snooze.bind(store);
    const spy = vi.spyOn(store, "snooze").mockRejectedValueOnce(new Error("blip")).mockImplementation(real);
    const summary = await tick();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(store.get(row.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(summary.snoozed).toBe(1);
  });

  it("does not query spend when no AI kind could be claimed", async () => {
    const { store, tick } = setup({ "plain.user": def() });
    const spy = vi.spyOn(store, "getAiSpendSince");
    store.add({ kind: "plain.user", task_class: "user" });
    await tick();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("runWorkerTick — self-chaining (§13.4.2)", () => {
  it("kicks once when it made progress and claimable user tasks remain", async () => {
    const { store, clock, kick, tick } = setup({
      "k.user": def({
        handler: async () => {
          clock.advance(WORKER_SOFT_STOP_MS); // tick runs out of time mid-queue
          return { outcome: "succeeded" };
        },
      }),
    });
    for (let i = 0; i < 6; i++) store.add({ kind: "k.user", task_class: "user" });

    const summary = await tick();

    expect(summary.stopReason).toBe("soft_stop");
    expect(summary.claimed).toBe(4);
    expect(kick).toHaveBeenCalledTimes(1);
    expect(summary.kicked).toBe(true);
  });

  it("does not kick when the queue was drained", async () => {
    const { store, kick, tick } = setup({ "k.user": def() });
    store.add({ kind: "k.user", task_class: "user" });
    await tick();
    expect(kick).not.toHaveBeenCalled();
  });

  it("does not kick without progress, even if user tasks are queued (no kick storm)", async () => {
    const { store, kick, tick } = setup({ "k.user": def() });
    // Global cap fully held by another live worker: this tick claims nothing.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    for (let i = 0; i < WORKER_MAX_RUNNING_USER; i++) {
      store.add({ kind: "k.user", task_class: "user", status: "running", attempts: 1, locked_by: "other", locked_until: future });
    }
    store.add({ kind: "k.user", task_class: "user" });

    const summary = await tick();

    expect(summary.claimed).toBe(0);
    expect(kick).not.toHaveBeenCalled();
  });

  it("does not kick for remaining background-only work", async () => {
    const { store, clock, kick, tick } = setup({
      "b.bg": def({
        class: "background",
        handler: async () => {
          clock.advance(WORKER_SOFT_STOP_MS);
          return { outcome: "succeeded" };
        },
      }),
    });
    for (let i = 0; i < 5; i++) store.add({ kind: "b.bg", task_class: "background" });
    await tick();
    expect(kick).not.toHaveBeenCalled();
  });

  it("a failing self-kick check is logged, not thrown", async () => {
    const { store, kick, logs, tick } = setup({ "k.user": def() });
    store.add({ kind: "k.user", task_class: "user" });
    vi.spyOn(store, "hasClaimableTasks").mockRejectedValue(new Error("db"));
    await expect(tick()).resolves.toMatchObject({ kicked: false });
    expect(kick).not.toHaveBeenCalled();
    expect(logs.some((l) => l.message.includes("self-kick check failed"))).toBe(true);
  });
});

describe("runWorkerTick — logging", () => {
  it("logs ids, kinds, codes and counts only (no payload values)", async () => {
    const { store, logs, tick } = setup({
      "l.user": def({ handler: async () => {
        throw new Error("secret");
      } }),
    });
    store.add({ kind: "l.user", task_class: "user", payload: { note: "Jane Doe resume" } });
    await tick();
    const text = JSON.stringify(logs);
    expect(text).not.toContain("Jane");
    expect(text).not.toContain("secret");
    expect(logs.at(-1)?.message).toBe("tick finished");
  });
});

describe("runWorkerTick — dead-task hook outbox (§13.4.5)", () => {
  function deadRow(store: FakeStore, kind: string, extra: Partial<BackgroundTaskRow> = {}) {
    return store.add({
      kind,
      task_class: "user",
      status: "dead",
      attempts: 3,
      last_error_code: "lease_expired",
      finished_at: new Date(Date.now() - 60_000).toISOString(),
      ...extra,
    });
  }

  it("fast path + sweep run the hook exactly once when nothing fails", async () => {
    const onDead = vi.fn().mockResolvedValue(undefined);
    const { store, tick } = setup({
      "d.user": def({ handler: async () => {
        throw new TaskError("ai_refused");
      }, onDead }),
    });
    const row = store.add({ kind: "d.user", task_class: "user" });

    const s1 = await tick();
    await tick(); // sweep must not re-run a handled hook

    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead.mock.calls[0][0]).toMatchObject({ errorCode: "ai_refused" });
    expect(onDead.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(store.get(row.id)).toMatchObject({ status: "dead", on_dead_attempts: 1, on_dead_locked_by: null });
    expect(store.get(row.id).on_dead_handled_at).not.toBeNull();
    expect(s1.deadHooksHandled).toBe(1);
  });

  it("a lease_expired dead-letter from claim_tasks gets its hook on the next tick's sweep", async () => {
    const onDead = vi.fn().mockResolvedValue(undefined);
    const { store, clock, tick } = setup({ "l.user": def({ onDead }) });
    const row = store.add({
      kind: "l.user", task_class: "user", status: "running", attempts: 3, max_attempts: 3,
      locked_by: "dead-worker", locked_until: new Date(clock.now() - 1000).toISOString(),
    });

    await tick(); // claim_tasks dead-letters it (no TS failure path ran)
    expect(store.get(row.id)).toMatchObject({ status: "dead", last_error_code: "lease_expired" });
    expect(onDead).not.toHaveBeenCalled();

    await tick(); // sweep delivers
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead.mock.calls[0][0]).toMatchObject({ errorCode: "lease_expired" });
    expect(store.get(row.id).on_dead_handled_at).not.toBeNull();
  });

  it("the sweep runs before the claim loop", async () => {
    const order: string[] = [];
    const { store, tick } = setup({
      "o.user": def({
        onDead: async () => {
          order.push("hook");
        },
        handler: async () => {
          order.push("task");
          return { outcome: "succeeded" };
        },
      }),
    });
    deadRow(store, "o.user");
    store.add({ kind: "o.user", task_class: "user" });
    await tick();
    expect(order).toEqual(["hook", "task"]);
  });

  it("a throwing hook stays pending, is redelivered after the 120 s lock, and gives up after 10", async () => {
    const onDead = vi.fn().mockRejectedValue(new Error("db write failed"));
    const { store, clock, logs, tick } = setup({ "t.user": def({ onDead }) });
    const row = deadRow(store, "t.user");

    await tick();
    expect(store.get(row.id)).toMatchObject({ on_dead_handled_at: null, on_dead_attempts: 1 });
    await tick(); // still locked: not redelivered yet
    expect(onDead).toHaveBeenCalledTimes(1);

    for (let i = 2; i <= 10; i++) {
      clock.advance(121_000);
      await tick();
    }
    expect(onDead).toHaveBeenCalledTimes(10);
    const r = store.get(row.id);
    expect(r.on_dead_handled_at).not.toBeNull();
    expect(r.last_error_message).toBe("onDead hook gave up after 10 attempts");
    expect(r.last_error_code).toBe("lease_expired");
    const alert = logs.find((l) => l.message === "onDead gave up");
    expect(alert?.level).toBe("error");
    expect(alert?.fields).toMatchObject({ alert: true, task_id: row.id, kind: "t.user", code: "lease_expired" });

    clock.advance(121_000);
    await tick();
    expect(onDead).toHaveBeenCalledTimes(10); // handled: never again
  });

  it("a worker that died mid-hook: the hook is redelivered after its lock expires", async () => {
    const onDead = vi.fn().mockResolvedValue(undefined);
    const { store, clock, tick } = setup({ "w.user": def({ onDead }) });
    const row = deadRow(store, "w.user");
    // Another invocation claimed the hook, then died before completing it.
    await store.claimDeadHooks({ workerId: "dead-worker", kinds: ["w.user"], limit: 1 });

    await tick();
    expect(onDead).not.toHaveBeenCalled();

    clock.advance(121_000);
    await tick();
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(store.get(row.id)).toMatchObject({ on_dead_attempts: 2 });
    expect(store.get(row.id).on_dead_handled_at).not.toBeNull();
  });

  it("two concurrent ticks never run the same hook concurrently", async () => {
    const g = gate();
    const onDead = vi.fn(async () => {
      await g.promise;
    });
    const { store, tick } = setup({ "c.user": def({ onDead }) });
    deadRow(store, "c.user");

    const t1 = tick();
    const t2 = tick();
    await tickMs(10);
    g.open();
    await Promise.all([t1, t2]);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("an unknown kind's hook stays pending (waits for a deployment that knows it)", async () => {
    const { store, tick } = setup({ "k.user": def() });
    const row = deadRow(store, "future.kind");
    await tick();
    expect(store.get(row.id)).toMatchObject({ on_dead_handled_at: null, on_dead_attempts: 0, on_dead_locked_by: null });
  });

  it("kinds without onDead are marked handled immediately", async () => {
    const { store, tick } = setup({ "n.user": def() });
    const row = deadRow(store, "n.user");
    const summary = await tick();
    expect(store.get(row.id).on_dead_handled_at).not.toBeNull();
    expect(summary.deadHooksHandled).toBe(1);
  });

  it("a hook that hangs is cut off by the per-hook timeout and left pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { store, tick } = setup({ "h.user": def({ onDead: () => new Promise<void>(() => {}) }) });
      const row = deadRow(store, "h.user");
      const pending = tick();
      await vi.advanceTimersByTimeAsync(15_000);
      const summary = await pending;
      expect(summary.deadHooksFailed).toBe(1);
      expect(store.get(row.id).on_dead_handled_at).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the sweep at the 20 s budget; the rest are redelivered later", async () => {
    const { store, clock, logs, tick } = setup({
      "b.user": def({
        onDead: async () => {
          clock.advance(21_000);
        },
      }),
    });
    deadRow(store, "b.user");
    const second = deadRow(store, "b.user");
    await tick();
    expect(store.get(second.id).on_dead_handled_at).toBeNull();
    expect(logs.some((l) => l.message.includes("sweep budget used up"))).toBe(true);
  });

  it("a claim_dead_task_hooks error doesn't stop the tick", async () => {
    const { store, tick } = setup({ "e.user": def() });
    store.hookClaimError = new Error("db");
    const row = store.add({ kind: "e.user", task_class: "user" });
    await tick();
    expect(store.get(row.id).status).toBe("succeeded");
  });
});

describe("runWorkerTick — review nits (sweep release, fast-path guard, noop snooze)", () => {
  function deadRow(store: FakeStore, kind: string, finishedAgoMs: number) {
    return store.add({
      kind,
      task_class: "user",
      status: "dead",
      attempts: 3,
      last_error_code: "internal_error",
      finished_at: new Date(Date.now() - finishedAgoMs).toISOString(),
    });
  }

  it("releases claimed-but-unrun hooks when the sweep budget runs out (attempt refunded, lock cleared)", async () => {
    const { store, clock, tick } = setup({
      "slow.user": def({ onDead: async () => {
        clock.advance(21_000);
      } }),
      "fast.user": def({ onDead: async () => {} }),
    });
    const slow = deadRow(store, "slow.user", 120_000); // oldest: claimed and run first
    const skipped = deadRow(store, "fast.user", 60_000);

    const summary = await tick();

    expect(store.get(slow.id).on_dead_handled_at).not.toBeNull();
    expect(store.get(skipped.id)).toMatchObject({
      on_dead_handled_at: null,
      on_dead_attempts: 0,
      on_dead_locked_by: null,
      on_dead_locked_until: null,
    });
    expect(summary.deadHooksReleased).toBe(1);

    // Released, not locked: the very next tick delivers it.
    await tick();
    expect(store.get(skipped.id).on_dead_handled_at).not.toBeNull();
  });

  it("a hook repeatedly skipped behind a slow failing one never reaches give-up without running", async () => {
    const victim = vi.fn().mockResolvedValue(undefined);
    const { store, clock, tick } = setup({
      "hog.user": def({ onDead: async () => {
        clock.advance(21_000); // eats the whole sweep budget...
        throw new Error("still failing"); // ...and fails every time
      } }),
      "victim.user": def({ onDead: victim }),
    });
    const hog = deadRow(store, "hog.user", 120_000);
    const v = deadRow(store, "victim.user", 60_000);

    for (let i = 0; i < 10; i++) {
      await tick();
      expect(store.get(v.id).on_dead_attempts).toBe(0); // never inflated
      clock.advance(121_000);
    }
    expect(store.get(hog.id).on_dead_handled_at).not.toBeNull(); // hog gave up after 10
    expect(victim).not.toHaveBeenCalled();

    await tick();
    expect(victim).toHaveBeenCalledTimes(1);
    expect(store.get(v.id)).toMatchObject({ on_dead_attempts: 1 });
    expect(store.get(v.id).last_error_message ?? "").not.toMatch(/gave up/);
  });

  it("claims hooks in small batches, capped at the sweep limit", async () => {
    const { store, tick } = setup({ "q.user": def({ onDead: async () => {} }) });
    for (let i = 0; i < 25; i++) deadRow(store, "q.user", 100_000 - i);
    const spy = vi.spyOn(store, "claimDeadHooks");

    const summary = await tick();

    const limits = spy.mock.calls.map(([args]) => args.limit);
    expect(Math.max(...limits)).toBeLessThanOrEqual(5);
    expect(limits.reduce((a, b) => a + b, 0)).toBe(20);
    expect(summary.deadHooksHandled).toBe(20);
    expect(store.rows.filter((r) => r.on_dead_handled_at === null)).toHaveLength(5);
  });

  it("stops claiming once the queue of pending hooks is drained", async () => {
    const { store, tick } = setup({ "q.user": def({ onDead: async () => {} }) });
    for (let i = 0; i < 3; i++) deadRow(store, "q.user", 10_000 + i);
    const spy = vi.spyOn(store, "claimDeadHooks");
    await tick();
    expect(spy).toHaveBeenCalledTimes(1); // got 3 < 5 requested: done
  });

  it("skips the fast path near the hard budget; the next sweep delivers the hook", async () => {
    const onDead = vi.fn().mockResolvedValue(undefined);
    const { store, clock, tick } = setup({
      "late.user": def({
        maxDurationMs: 10_000,
        handler: async () => {
          clock.advance(WORKER_HARD_BUDGET_MS - 30_000); // finishes late in the tick
          throw new TaskError("ai_refused");
        },
        onDead,
      }),
    });
    const row = store.add({ kind: "late.user", task_class: "user" });

    const summary = await tick();

    expect(store.get(row.id).status).toBe("dead");
    expect(onDead).not.toHaveBeenCalled();
    expect(summary.deadHooksDeferredToSweep).toBe(1);

    await tick();
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("uses the fast path when there is room", async () => {
    const onDead = vi.fn().mockResolvedValue(undefined);
    const { store, tick } = setup({ "now.user": def({ handler: async () => {
      throw new TaskError("ai_refused");
    }, onDead }) });
    store.add({ kind: "now.user", task_class: "user" });
    const summary = await tick();
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(summary.deadHooksDeferredToSweep).toBe(0);
  });

  it('maintenance.noop {"snooze_seconds":N,"force_fail":true} snoozes once, then dies (no infinite snooze)', async () => {
    const { store, clock, tick } = setup(taskRegistry);
    const row = store.add({
      kind: "maintenance.noop",
      task_class: "background",
      max_attempts: 3,
      lease_seconds: 60,
      payload: { snooze_seconds: 30, force_fail: true },
    });

    let snoozes = 0;
    for (let i = 0; i < 12 && store.get(row.id).status !== "dead"; i++) {
      const s = await tick();
      snoozes += s.snoozed;
      clock.advance(3_700_000); // past any snooze/backoff
    }

    expect(snoozes).toBe(1);
    expect(store.get(row.id)).toMatchObject({ status: "dead", attempts: 3, last_error_code: "internal_error" });
  });
});

describe("createWorkerStore — per-call DB timeouts", () => {
  it("attaches an AbortSignal.timeout to every PostgREST call", async () => {
    const { createWorkerStore, WORKER_DB_TIMEOUT_MS } = await import("@/lib/tasks/worker");
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const abortSignal = vi.fn();
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "lte", "limit"]) builder[m] = () => builder;
    builder.abortSignal = (signal: AbortSignal) => {
      abortSignal(signal);
      return Promise.resolve({ data: [], error: null });
    };
    const rpcResult = {
      abortSignal: (signal: AbortSignal) => {
        abortSignal(signal);
        return Promise.resolve({ data: null, error: null });
      },
    };
    const admin = { rpc: vi.fn(() => rpcResult), from: vi.fn(() => builder) } as never;
    const store = createWorkerStore(admin);

    await store.claim({ workerId: "w", taskClass: "user", kinds: ["a.b"], maxRunning: 4, limit: 1 });
    await store.complete("t", "w", null);
    await store.fail({ id: "t", workerId: "w", errorCode: "internal_error", errorMessage: null, retryable: true, retryDelaySeconds: 30 });
    await store.snooze({ id: "t", workerId: "w", seconds: 5, reason: "x" });
    await store.hasClaimableTasks({ taskClass: "user", kinds: ["a.b"], now: new Date() });
    await store.getAiSpendSince(new Date());
    await store.defer({ taskClass: "user", kinds: ["a.b"], until: new Date(), maxJitterSeconds: 900, limit: 200 });
    await store.claimDeadHooks({ workerId: "w", kinds: ["a.b"], limit: 20 });
    await store.completeDeadHook({ id: "t", workerId: "w", gaveUp: false });
    await store.releaseDeadHook({ id: "t", workerId: "w" });

    expect(abortSignal).toHaveBeenCalledTimes(10);
    for (const [signal] of abortSignal.mock.calls) expect(signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledTimes(10);
    expect(timeoutSpy).toHaveBeenCalledWith(WORKER_DB_TIMEOUT_MS);
  });
});
