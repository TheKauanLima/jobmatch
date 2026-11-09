import { describe, expect, it } from "vitest";

import {
  isFirstClaim,
  NOOP_SNOOZE_REASON,
  noopPayloadSchema,
  runNoopTask,
  type NoopPayload,
} from "@/lib/tasks/handlers/maintenance/noop";
import { TaskError } from "@/lib/tasks/errors";
import type { BackgroundTaskRow, TaskContext } from "@/lib/tasks/types";

/** Row timestamps as claim_tasks leaves them on the first / a later claim. */
const FIRST_CLAIM = {
  started_at: "2026-11-09T12:00:00.000Z",
  locked_until: "2026-11-09T12:01:00.000Z",
  lease_seconds: 60,
};
const LATER_CLAIM = {
  started_at: "2026-11-09T12:00:00.000Z",
  locked_until: "2026-11-09T12:10:00.000Z",
  lease_seconds: 60,
};

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

  it("snoozes on the first claim only, then succeeds on the re-claim", async () => {
    await expect(runNoopTask(ctx({ snooze_seconds: 30 }, FIRST_CLAIM))).resolves.toEqual({
      outcome: "snooze",
      seconds: 30,
      reason: NOOP_SNOOZE_REASON,
    });
    await expect(runNoopTask(ctx({ snooze_seconds: 30 }, LATER_CLAIM))).resolves.toMatchObject({
      outcome: "succeeded",
    });
  });

  it("does not depend on last_error_code (snooze_task preserves prior codes)", async () => {
    // Regression: after a failure the code is internal_error, never the
    // snooze reason; keying off it would snooze forever.
    await expect(
      runNoopTask(ctx({ snooze_seconds: 30, force_fail: true }, { ...LATER_CLAIM, last_error_code: "internal_error" })),
    ).rejects.toBeInstanceOf(TaskError);
  });

  describe("isFirstClaim", () => {
    it("is true only when started_at == locked_until − lease", () => {
      expect(isFirstClaim(FIRST_CLAIM)).toBe(true);
      expect(isFirstClaim(LATER_CLAIM)).toBe(false);
    });

    it("tolerates PostgREST microsecond timestamps", () => {
      expect(
        isFirstClaim({
          started_at: "2026-11-09T12:00:00.123456+00:00",
          locked_until: "2026-11-09T12:01:00.123456+00:00",
          lease_seconds: 60,
        }),
      ).toBe(true);
    });

    it("is false when either timestamp is missing", () => {
      expect(isFirstClaim({ started_at: null, locked_until: FIRST_CLAIM.locked_until, lease_seconds: 60 })).toBe(false);
      expect(isFirstClaim({ started_at: FIRST_CLAIM.started_at, locked_until: null, lease_seconds: 60 })).toBe(false);
    });
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
