import { describe, expect, it, vi } from "vitest";

import {
  cancelQueuedTasksForUser,
  claimDeadTaskHooks,
  claimTasks,
  completeDeadTaskHook,
  completeTask,
  countPendingDeadHooks,
  deferQueuedTasks,
  enqueueTaskRow,
  extendTaskLease,
  failTask,
  getTaskCounts,
  hasClaimableTasks,
  listRecentDeadTasks,
  releaseDeadTaskHook,
  snoozeTask,
  TaskQueryError,
} from "@/lib/supabase/queries/tasks";

function rpcClient(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as never, rpc };
}

function selectClient(result: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "lte", "order", "limit"]) {
    builder[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const from = vi.fn(() => builder);
  return { client: { from } as never, from, calls };
}

describe("tasks queries", () => {
  it("enqueueTaskRow maps args onto enqueue_task's parameters", async () => {
    const { client, rpc } = rpcClient({ data: "id-1", error: null });
    const runAfter = new Date("2026-11-05T00:00:00.000Z");
    const id = await enqueueTaskRow(client, {
      kind: "maintenance.noop",
      taskClass: "background",
      payload: { a: 1 },
      userId: "u",
      dedupeKey: "d",
      priority: 5,
      maxAttempts: 3,
      leaseSeconds: 60,
      runAfter,
      correlationId: "c",
      parentTaskId: "p",
    });
    expect(id).toBe("id-1");
    expect(rpc).toHaveBeenCalledWith("enqueue_task", {
      p_kind: "maintenance.noop",
      p_task_class: "background",
      p_payload: { a: 1 },
      p_user_id: "u",
      p_dedupe_key: "d",
      p_priority: 5,
      p_max_attempts: 3,
      p_lease_seconds: 60,
      p_run_after: "2026-11-05T00:00:00.000Z",
      p_correlation_id: "c",
      p_parent_task_id: "p",
    });
  });

  it("throws TaskQueryError with code, never row data", async () => {
    const { client } = rpcClient({ data: null, error: { code: "42501", message: "permission denied for function enqueue_task" } });
    const err = await enqueueTaskRow(client, {
      kind: "k.k", taskClass: "user", payload: {}, userId: null, dedupeKey: null, priority: 0,
      maxAttempts: 1, leaseSeconds: 60, runAfter: null, correlationId: null, parentTaskId: null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskQueryError);
    expect((err as TaskQueryError).code).toBe("42501");
    expect((err as Error).message).toContain("enqueue_task failed (42501)");
  });

  it("claimTasks short-circuits on no kinds / no slots without calling the DB", async () => {
    const { client, rpc } = rpcClient({ data: [], error: null });
    expect(await claimTasks(client, { workerId: "w", taskClass: "user", kinds: [], maxRunning: 4, limit: 4 })).toEqual([]);
    expect(await claimTasks(client, { workerId: "w", taskClass: "user", kinds: ["a.b"], maxRunning: 4, limit: 0 })).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("claimTasks passes the cap and limit through", async () => {
    const { client, rpc } = rpcClient({ data: [{ id: "t" }], error: null });
    const rows = await claimTasks(client, { workerId: "w", taskClass: "user", kinds: ["a.b"], maxRunning: 4, limit: 2 });
    expect(rows).toEqual([{ id: "t" }]);
    expect(rpc).toHaveBeenCalledWith("claim_tasks", {
      p_worker_id: "w", p_task_class: "user", p_kinds: ["a.b"], p_max_running: 4, p_limit: 2,
    });
  });

  it("fenced functions return their boolean / status", async () => {
    expect(await completeTask(rpcClient({ data: true, error: null }).client, "t", "w", null)).toBe(true);
    expect(await completeTask(rpcClient({ data: false, error: null }).client, "t", "w", null)).toBe(false);
    expect(await snoozeTask(rpcClient({ data: true, error: null }).client, { id: "t", workerId: "w", seconds: 5, reason: "x" })).toBe(true);
    expect(await extendTaskLease(rpcClient({ data: false, error: null }).client, "t", "w", 60)).toBe(false);

    const failArgs = { id: "t", workerId: "w", errorCode: "internal_error", errorMessage: null, retryable: true, retryDelaySeconds: 30 };
    expect(await failTask(rpcClient({ data: "queued", error: null }).client, failArgs)).toBe("queued");
    expect(await failTask(rpcClient({ data: "dead", error: null }).client, failArgs)).toBe("dead");
    expect(await failTask(rpcClient({ data: null, error: null }).client, failArgs)).toBeNull();
  });

  it("cancelQueuedTasksForUser returns the count", async () => {
    const { client, rpc } = rpcClient({ data: 3, error: null });
    expect(await cancelQueuedTasksForUser(client, "u1")).toBe(3);
    expect(rpc).toHaveBeenCalledWith("cancel_tasks_for_user", { p_user_id: "u1" });
  });

  it("hasClaimableTasks filters queued + class + kinds + run_after <= now", async () => {
    const { client, calls } = selectClient({ data: [{ id: "t" }], error: null });
    const now = new Date("2026-11-04T12:00:00.000Z");
    expect(await hasClaimableTasks(client, { taskClass: "user", kinds: ["a.b"], now })).toBe(true);
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["status", "queued"] },
        { method: "eq", args: ["task_class", "user"] },
        { method: "in", args: ["kind", ["a.b"]] },
        { method: "lte", args: ["run_after", "2026-11-04T12:00:00.000Z"] },
        { method: "limit", args: [1] },
      ]),
    );
    expect(await hasClaimableTasks(client, { taskClass: "user", kinds: [], now })).toBe(false);
  });

  it("getTaskCounts nests kind → status → n", async () => {
    const { client } = rpcClient({
      data: [
        { kind: "a.b", status: "queued", n: 2 },
        { kind: "a.b", status: "dead", n: 1 },
        { kind: "c.d", status: "succeeded", n: "7" },
      ],
      error: null,
    });
    expect(await getTaskCounts(client)).toEqual({ "a.b": { queued: 2, dead: 1 }, "c.d": { succeeded: 7 } });
  });

  it("passes an abort signal through when given (worker timeouts)", async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: true, error: null });
    const rpc = vi.fn(() => ({ abortSignal }));
    const signal = AbortSignal.timeout(1000);
    expect(await completeTask({ rpc } as never, "t", "w", null, { signal })).toBe(true);
    expect(abortSignal).toHaveBeenCalledWith(signal);
  });

  it("an aborted call surfaces as TaskQueryError", async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: null, error: { code: "", message: "AbortError: signal timed out" } });
    const rpc = vi.fn(() => ({ abortSignal }));
    await expect(
      claimTasks({ rpc } as never, { workerId: "w", taskClass: "user", kinds: ["a.b"], maxRunning: 4, limit: 1 }, { signal: AbortSignal.timeout(1) }),
    ).rejects.toBeInstanceOf(TaskQueryError);
  });

  it("deferQueuedTasks maps args onto defer_queued_tasks", async () => {
    const { client, rpc } = rpcClient({ data: [{ id: "t" }], error: null });
    const until = new Date("2026-11-05T00:00:00.000Z");
    expect(await deferQueuedTasks(client, { taskClass: "user", kinds: ["a.b"], until, maxJitterSeconds: 900, limit: 200 })).toEqual([{ id: "t" }]);
    expect(rpc).toHaveBeenCalledWith("defer_queued_tasks", {
      p_task_class: "user", p_kinds: ["a.b"], p_until: "2026-11-05T00:00:00.000Z", p_max_jitter_seconds: 900, p_limit: 200,
    });
    expect(await deferQueuedTasks(client, { taskClass: "user", kinds: [], until, maxJitterSeconds: 900, limit: 200 })).toEqual([]);
  });

  it("claimDeadTaskHooks / completeDeadTaskHook map onto the outbox functions", async () => {
    const claim = rpcClient({ data: [{ id: "t" }], error: null });
    expect(await claimDeadTaskHooks(claim.client, { workerId: "w", kinds: ["a.b"], limit: 20, taskId: "t" })).toEqual([{ id: "t" }]);
    expect(claim.rpc).toHaveBeenCalledWith("claim_dead_task_hooks", { p_worker_id: "w", p_kinds: ["a.b"], p_limit: 20, p_task_id: "t" });

    const done = rpcClient({ data: true, error: null });
    expect(await completeDeadTaskHook(done.client, { id: "t", workerId: "w", gaveUp: true })).toBe(true);
    expect(done.rpc).toHaveBeenCalledWith("complete_dead_task_hook", { p_id: "t", p_worker_id: "w", p_gave_up: true });

    const released = rpcClient({ data: false, error: null });
    expect(await releaseDeadTaskHook(released.client, { id: "t", workerId: "w" })).toBe(false);
    expect(released.rpc).toHaveBeenCalledWith("release_dead_task_hook", { p_id: "t", p_worker_id: "w" });
    await expect(
      releaseDeadTaskHook(rpcClient({ data: null, error: { code: "42501", message: "denied" } }).client, { id: "t", workerId: "w" }),
    ).rejects.toBeInstanceOf(TaskQueryError);
  });

  it("countPendingDeadHooks uses an exact HEAD count of unhandled dead rows", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const builder: Record<string, unknown> = {};
    builder.select = (...args: unknown[]) => {
      calls.push({ method: "select", args });
      return builder;
    };
    builder.eq = (...args: unknown[]) => {
      calls.push({ method: "eq", args });
      return builder;
    };
    builder.is = (...args: unknown[]) => {
      calls.push({ method: "is", args });
      return Promise.resolve({ count: 5, error: null });
    };
    const from = vi.fn(() => builder);
    expect(await countPendingDeadHooks({ from } as never)).toBe(5);
    expect(calls).toEqual([
      { method: "select", args: ["id", { count: "exact", head: true }] },
      { method: "eq", args: ["status", "dead"] },
      { method: "is", args: ["on_dead_handled_at", null] },
    ]);
  });

  it("listRecentDeadTasks selects metadata columns only", async () => {
    const { client, calls } = selectClient({
      data: [{ id: "t", kind: "a.b", last_error_code: "x", attempts: 3, finished_at: "2026-11-04T00:00:00Z" }],
      error: null,
    });
    const rows = await listRecentDeadTasks(client);
    expect(rows).toEqual([{ id: "t", kind: "a.b", code: "x", attempts: 3, finished_at: "2026-11-04T00:00:00Z" }]);
    const select = calls.find((c) => c.method === "select");
    expect(select?.args[0]).toBe("id, kind, last_error_code, attempts, finished_at");
    expect(String(select?.args[0])).not.toMatch(/payload|result|message/);
    expect(calls).toContainEqual({ method: "limit", args: [20] });
  });
});
