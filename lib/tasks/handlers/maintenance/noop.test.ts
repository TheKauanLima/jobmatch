import { describe, expect, it } from "vitest";

import {
  NOOP_SNOOZE_REASON,
  noopPayloadSchema,
  runNoopTask,
  type NoopPayload,
} from "@/lib/tasks/handlers/maintenance/noop";
import { TaskError } from "@/lib/tasks/errors";
import type { BackgroundTaskRow, TaskContext } from "@/lib/tasks/types";

function ctx(payload: NoopPayload, task: Partial<BackgroundTaskRow> = {}, signal = new AbortController().signal) {
  return {
    task: { id: "t1", attempts: 1, last_error_code: null, ...task } as BackgroundTaskRow,
    payload,
    admin: {} as never,
    signal,
    deadline: Date.now() + 10_000,
    log: { info() {}, warn() {}, error() {} },
  } satisfies TaskContext<NoopPayload>;
}

describe("maintenance.noop", () => {
  it("succeeds by default", async () => {
    await expect(runNoopTask(ctx({}))).resolves.toEqual({
      outcome: "succeeded",
      result: { noop: true, attempt: 1 },
    });
  });

  it("force_fail throws a retryable TaskError", async () => {
    const err = await runNoopTask(ctx({ force_fail: true })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskError);
    expect((err as TaskError).code).toBe("internal_error");
    expect((err as TaskError).retryable).toBe(true);
  });

  it("force_fail + retryable:false throws a non-retryable TaskError", async () => {
    const err = await runNoopTask(ctx({ force_fail: true, retryable: false })).catch((e: unknown) => e);
    expect((err as TaskError).retryable).toBe(false);
  });

  it("snoozes once, then succeeds on the re-claim", async () => {
    await expect(runNoopTask(ctx({ snooze_seconds: 30 }))).resolves.toEqual({
      outcome: "snooze",
      seconds: 30,
      reason: NOOP_SNOOZE_REASON,
    });
    await expect(
      runNoopTask(ctx({ snooze_seconds: 30 }, { last_error_code: NOOP_SNOOZE_REASON })),
    ).resolves.toMatchObject({ outcome: "succeeded" });
  });

  it("sleep honors the abort signal", async () => {
    const controller = new AbortController();
    const promise = runNoopTask(ctx({ sleep_ms: 5_000 }, {}, controller.signal));
    controller.abort(new Error("deadline"));
    await expect(promise).rejects.toThrow("deadline");
  });

  it("schema is strict and bounded", () => {
    expect(noopPayloadSchema.safeParse({}).success).toBe(true);
    expect(noopPayloadSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(noopPayloadSchema.safeParse({ sleep_ms: 5_001 }).success).toBe(false);
    expect(noopPayloadSchema.safeParse({ snooze_seconds: 1 }).success).toBe(false);
  });
});
