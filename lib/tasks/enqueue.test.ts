import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnqueueTaskRow } = vi.hoisted(() => ({ mockEnqueueTaskRow: vi.fn() }));

vi.mock("@/lib/supabase/queries/tasks", () => ({
  enqueueTaskRow: mockEnqueueTaskRow,
}));

const { enqueueTask, EnqueueValidationError, MAX_PAYLOAD_BYTES } = await import("@/lib/tasks/enqueue");
const { TASK_REGISTRY } = await import("@/lib/tasks/registry");

const admin = {} as never;
const USER_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  mockEnqueueTaskRow.mockResolvedValue("task-id-1");
});

describe("enqueueTask", () => {
  it("takes class/priority/attempts/lease from the registry, not the caller", async () => {
    const id = await enqueueTask(admin, "maintenance.noop", { force_fail: true }, {
      userId: USER_ID,
      dedupeKey: "noop:test",
    });

    expect(id).toBe("task-id-1");
    const def = TASK_REGISTRY["maintenance.noop"];
    expect(mockEnqueueTaskRow).toHaveBeenCalledWith(admin, {
      kind: "maintenance.noop",
      taskClass: def.class,
      payload: { force_fail: true },
      userId: USER_ID,
      dedupeKey: "noop:test",
      priority: def.priority,
      maxAttempts: def.maxAttempts,
      leaseSeconds: def.leaseSeconds,
      runAfter: null,
      correlationId: null,
      parentTaskId: null,
    });
  });

  it("passes runAfter / correlation / parent through", async () => {
    const runAfter = new Date("2026-11-05T00:00:00Z");
    await enqueueTask(admin, "maintenance.noop", {}, {
      runAfter,
      correlationId: "c-1",
      parentTaskId: "p-1",
    });
    expect(mockEnqueueTaskRow.mock.calls[0][1]).toMatchObject({
      runAfter,
      correlationId: "c-1",
      parentTaskId: "p-1",
      userId: null,
      dedupeKey: null,
    });
  });

  it("rejects payloads that fail the kind's schema, reporting paths but not values", async () => {
    const err = await enqueueTask(admin, "maintenance.noop", {
      sleep_ms: "Jane Doe resume text",
    } as never).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnqueueValidationError);
    expect((err as Error).message).toContain("sleep_ms");
    expect((err as Error).message).not.toContain("Jane");
    expect(mockEnqueueTaskRow).not.toHaveBeenCalled();
  });

  it("rejects unknown payload keys (strict schema)", async () => {
    await expect(
      enqueueTask(admin, "maintenance.noop", { resume_text: "..." } as never),
    ).rejects.toBeInstanceOf(EnqueueValidationError);
  });

  it("rejects unknown kinds", async () => {
    await expect(
      enqueueTask(admin, "not.registered" as never, {} as never),
    ).rejects.toThrow(/unknown task kind/);
  });

  it("exposes the same payload cap as the DB check", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(4096);
  });

  it("propagates query errors", async () => {
    mockEnqueueTaskRow.mockRejectedValue(new Error("enqueue_task failed"));
    await expect(enqueueTask(admin, "maintenance.noop", {})).rejects.toThrow("enqueue_task failed");
  });
});
