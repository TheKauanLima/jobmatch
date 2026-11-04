import { describe, expect, it, vi } from "vitest";

import {
  CANCEL_TASKS_FOR_USER_ENABLED,
  cancelQueuedTasksForUser,
  CancelTasksError,
} from "@/lib/account/cancelUserTasks";
import { USER_A } from "@/lib/account/testing/fakeStorage";

function adminWithRpc(result: { error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { admin: { rpc } as never, rpc };
}

describe("cancelQueuedTasksForUser", () => {
  it("is gated off until M1.2's migration 0007 lands", () => {
    // Flip to true when 0007 (cancel_tasks_for_user) is applied — see the
    // module docstring. This assertion is expected to change with it.
    expect(CANCEL_TASKS_FOR_USER_ENABLED).toBe(false);
  });

  it("is a no-op that makes no RPC call while gated off", async () => {
    const { admin, rpc } = adminWithRpc({ error: null });

    const result = await cancelQueuedTasksForUser(admin, USER_A);

    expect(result).toEqual({ skipped: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("when enabled, calls cancel_tasks_for_user with the session user id", async () => {
    const { admin, rpc } = adminWithRpc({ error: null });

    const result = await cancelQueuedTasksForUser(admin, USER_A, {
      enabled: true,
    });

    expect(result).toEqual({ skipped: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("cancel_tasks_for_user", {
      p_user_id: USER_A,
    });
  });

  it("when enabled, throws CancelTasksError on an RPC error", async () => {
    const { admin } = adminWithRpc({ error: { message: "boom" } });

    await expect(
      cancelQueuedTasksForUser(admin, USER_A, { enabled: true }),
    ).rejects.toBeInstanceOf(CancelTasksError);
  });
});
