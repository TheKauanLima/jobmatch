import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";

/**
 * Cancels the user's queued background tasks before account deletion
 * (docs/ARCHITECTURE.md §13.13.7 step 2), via the service-role-only
 * `cancel_tasks_for_user(p_user_id)` function defined in §13.3.1.
 *
 * FEATURE GATE: that function ships in migration `0007_background_infra.sql`
 * (milestone M1.2), which has not landed yet. Until it does, this is a no-op.
 *
 * To enable once 0007 is applied in every environment the app runs against:
 *   1. Set `CANCEL_TASKS_FOR_USER_ENABLED` below to `true`.
 *   2. (Cleanup, after `types/database.ts` is regenerated with the function)
 *      replace the `UntypedRpcClient` cast with a plain
 *      `admin.rpc("cancel_tasks_for_user", { p_user_id: userId })` so the
 *      argument name is type-checked.
 *
 * Deliberately a code constant, not runtime detection (e.g. treating
 * "function not found" as success): detection would also silently swallow a
 * genuinely missing function after M1.2, which is exactly the failure this
 * step exists to prevent.
 */
export const CANCEL_TASKS_FOR_USER_ENABLED = false;

export class CancelTasksError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "CancelTasksError";
  }
}

type AdminClient = SupabaseClient<Database>;

/**
 * `cancel_tasks_for_user` isn't in the generated `Database` type yet, so the
 * typed `rpc()` overloads reject its name. This narrow structural view is the
 * only escape hatch; see step 2 above for removing it.
 */
type UntypedRpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ error: { message: string } | null }>;
};

/**
 * Cancels queued tasks for `userId` (from the verified session, never request
 * input). No-op while the feature gate is off. Throws `CancelTasksError` on an
 * RPC error; the caller treats that as fatal-before-anything-is-deleted. The
 * underlying update (`queued` → `cancelled`) is idempotent, so retries are safe.
 *
 * `options.enabled` exists so tests can exercise the enabled path without
 * flipping the module constant.
 */
export async function cancelQueuedTasksForUser(
  admin: AdminClient,
  userId: string,
  options: { enabled?: boolean } = {},
): Promise<{ skipped: boolean }> {
  const enabled = options.enabled ?? CANCEL_TASKS_FOR_USER_ENABLED;
  if (!enabled) {
    return { skipped: true };
  }

  const { error } = await (admin as unknown as UntypedRpcClient).rpc(
    "cancel_tasks_for_user",
    { p_user_id: userId },
  );

  if (error) {
    throw new CancelTasksError(
      `cancel_tasks_for_user failed: ${error.message}`,
      error,
    );
  }

  return { skipped: false };
}
