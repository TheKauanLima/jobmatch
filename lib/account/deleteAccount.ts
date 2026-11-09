import { isAuthApiError } from "@supabase/supabase-js";

import { purgeUserResumeObjects } from "@/lib/account/purgeUserStorage";
import { verifyPassword } from "@/lib/account/reauthenticate";
import { createAdminClient } from "@/lib/supabase/admin";
import { cancelQueuedTasksForUser } from "@/lib/supabase/queries/tasks";

/**
 * Self-serve account deletion, per docs/ARCHITECTURE.md §13.13.7 and the
 * cascade summary in §13.3.12. Called by `DELETE /api/account`; the route
 * owns HTTP concerns and step 5 (clearing the session cookies, see
 * `lib/account/clearAuthSession.ts`), this module owns steps 1–4:
 *
 *   1. Re-authenticate with the password on a throwaway, non-cookie client.
 *      Wrong password → `reauth_failed` (403). Nothing else has happened.
 *   2. `cancel_tasks_for_user` via
 *      `lib/supabase/queries/tasks.ts#cancelQueuedTasksForUser`: the user's
 *      queued background tasks become `cancelled`. Failure → stop, nothing
 *      deleted.
 *   3. Purge every object under `{user_id}/` in the `resumes` bucket
 *      (paginated). Failure → stop; no DB row and no auth user has been
 *      touched, so the request is safely retryable. Objects removed before
 *      the failure stay removed; the retry lists and removes what's left.
 *   4. `auth.admin.deleteUser(user_id)` — hard delete. The database cascades
 *      every user-linked row (§13.3.12; today: `resumes`, `resume_analyses`,
 *      `matches` cascade and `job_descriptions.submitted_by` is set null —
 *      supabase/migrations/0001_init.sql). A 404 "user not found" counts as
 *      success (a concurrent request already finished the job).
 *
 * Then, best effort, a second Storage sweep catches any object uploaded in
 * the window between step 3 and step 4 (e.g. a second tab mid-upload). It
 * cannot be made fatal — the account is already gone — so a failure there
 * is logged (no identifiers) and the deletion still reports success.
 *
 * Idempotency: every step is safe to repeat. Re-running after a failure at
 * step 2/3/4 re-verifies the password (the account still exists), skips
 * through already-empty Storage, and completes the delete.
 *
 * Inputs: `userId` and `email` MUST come from the verified session
 * (`requireSession()`), never from the request body. The admin client is
 * only ever pointed at that `userId` (§13.15 item 3).
 *
 * PII: the password and email are never logged or included in results.
 * Logs carry only the failing step and the upstream error message (Storage
 * and Auth admin errors don't contain resume content; Storage paths are
 * server-generated uuids).
 */

export type AccountDeletionStep =
  | "reauth"
  | "setup"
  | "cancel_tasks"
  | "storage_purge"
  | "delete_user";

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; reason: "reauth_failed" }
  | { ok: false; reason: "failed"; step: AccountDeletionStep };

export async function deleteAccount(params: {
  userId: string;
  email: string | null | undefined;
  password: string;
}): Promise<DeleteAccountResult> {
  const { userId, email, password } = params;

  // Step 1: re-authenticate. Nothing has been touched yet.
  let reauth;
  try {
    reauth = await verifyPassword({ userId, email, password });
  } catch (err) {
    logStepFailure("reauth", err);
    return { ok: false, reason: "failed", step: "reauth" };
  }
  if (reauth === "invalid") {
    return { ok: false, reason: "reauth_failed" };
  }
  if (reauth !== "ok") {
    logStepFailure("reauth", new Error("password check unavailable"));
    return { ok: false, reason: "failed", step: "reauth" };
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (err) {
    // Deployment/config problem (e.g. missing service-role key), not a
    // task-cancel failure. Internal label only; never sent to the client.
    logStepFailure("setup", err);
    return { ok: false, reason: "failed", step: "setup" };
  }

  // Step 2: stop queued background work for this user.
  try {
    await cancelQueuedTasksForUser(admin, userId);
  } catch (err) {
    logStepFailure("cancel_tasks", err);
    return { ok: false, reason: "failed", step: "cancel_tasks" };
  }

  // Step 3: remove every Storage object. Must fully succeed before step 4 —
  // once the auth user is gone there is no authenticated way to retry.
  try {
    await purgeUserResumeObjects(admin, userId);
  } catch (err) {
    logStepFailure("storage_purge", err);
    return { ok: false, reason: "failed", step: "storage_purge" };
  }

  // Step 4: hard-delete the auth user; the DB cascades the rest.
  try {
    const { error } = await admin.auth.admin.deleteUser(userId, false);
    if (error && !isUserNotFound(error)) {
      logStepFailure("delete_user", error);
      return { ok: false, reason: "failed", step: "delete_user" };
    }
  } catch (err) {
    logStepFailure("delete_user", err);
    return { ok: false, reason: "failed", step: "delete_user" };
  }

  // Best-effort sweep for objects that raced in between steps 3 and 4.
  try {
    await purgeUserResumeObjects(admin, userId);
  } catch (err) {
    console.error(
      "deleteAccount: post-deletion Storage sweep failed (account already deleted):",
      errorMessage(err),
    );
  }

  return { ok: true };
}

function isUserNotFound(error: unknown): boolean {
  return (
    isAuthApiError(error) &&
    (error.status === 404 || error.code === "user_not_found")
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

function logStepFailure(step: AccountDeletionStep, err: unknown): void {
  console.error(`deleteAccount: step "${step}" failed:`, errorMessage(err));
}
