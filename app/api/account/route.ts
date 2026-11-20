import { NextResponse } from "next/server";

import { clearAuthSession } from "@/lib/account/clearAuthSession";
import { deleteAccount } from "@/lib/account/deleteAccount";
import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { consumeAccountReauthAttempt, RateLimitRpcError } from "@/lib/rateLimit";
import { createClient } from "@/lib/supabase/server";
import { accountDeleteSchema } from "@/lib/validation/schemas";

/**
 * Paginated Storage purge + Auth admin delete can take a while for an account
 * with many objects (docs/ARCHITECTURE.md §13.13.7).
 */
export const maxDuration = 60;

/**
 * The one `500` body for this route (§13.13.7 copy). Every 500 here happens
 * before the auth user is deleted, so "your account still exists" is true.
 */
const INTERNAL_ERROR_BODY = {
  error: "We couldn't finish deleting your account. Your account still exists — please try again.",
  code: "internal_error",
} as const;

/** SQLSTATE foreign_key_violation: rate_limit_events.user_id → auth.users. */
const POSTGRES_FOREIGN_KEY_VIOLATION = "23503";

/**
 * DELETE /api/account — self-serve account deletion, per
 * docs/ARCHITECTURE.md §13.13.7.
 *
 * Request: `{ "password": string, "confirm": "DELETE" }`.
 * Response: `204` with the session cookies cleared.
 * Errors:
 *   - `400 { error, code: "validation_failed" }` — bad/missing JSON body.
 *   - `401 { error }` — no session.
 *   - `403 { error, code: "reauth_failed" }` — wrong password.
 *   - `429 { error, code: "rate_limited", kind: "account_reauth",
 *     retry_after }` — the caller has used today's password re-auth attempts
 *     (`retry_after` = next UTC midnight). GoTrue is never contacted.
 *   - `500 { error, code: "internal_error" }` — a deletion step failed, or
 *     the re-auth rate-limit check itself failed (fails closed, GoTrue is
 *     never contacted). When this happens before the auth user is deleted
 *     (always, by construction of `deleteAccount`), the account still exists
 *     and the request can simply be retried.
 *   - A rate-limit RPC failing with 23503 / 42501 means a concurrent request
 *     already deleted the user → `401`, like a missing session.
 *
 * Step 0 (re-auth rate limit, §13.13.7 "Re-auth rate limiting") runs here,
 * after body validation and before `deleteAccount`, so a rejected or
 * unverifiable attempt never reaches GoTrue's `signInWithPassword`.
 *
 * Thin handler: the deletion sequence lives in `lib/account/deleteAccount.ts`.
 * The user id and email come from the verified session only; the request
 * body is never used to choose whose account is deleted. The password is
 * never logged, and validation errors never echo it.
 */
export async function DELETE(request: Request) {
  let user;
  try {
    ({ user } = await requireSession());
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(
      "DELETE /api/account: session check failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      INTERNAL_ERROR_BODY,
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Expected a JSON request body.", code: "validation_failed" },
      { status: 400 },
    );
  }

  const parsed = accountDeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Invalid request body.",
        code: "validation_failed",
      },
      { status: 400 },
    );
  }

  // Step 0: charge one `account_reauth` attempt to the session user before
  // anything contacts GoTrue. Fails closed.
  try {
    const supabase = await createClient();
    const attempt = await consumeAccountReauthAttempt(supabase);
    if (!attempt.allowed) {
      return NextResponse.json(
        {
          error:
            "Too many password attempts today. Try again after the daily reset.",
          code: "rate_limited",
          kind: "account_reauth",
          retry_after: attempt.retryAfter,
        },
        { status: 429 },
      );
    }
  } catch (err) {
    // A concurrent request already deleted this user (lost-204 retry or a
    // double-submit): the consume insert hits the FK to auth.users (23503),
    // or the RPC sees no auth.uid() (42501). Report 401, which M1.4b treats
    // as "already deleted", not "your account still exists".
    if (
      err instanceof RateLimitRpcError &&
      (err.isUnauthenticated || err.code === POSTGRES_FOREIGN_KEY_VIOLATION)
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error(
      "DELETE /api/account: re-auth rate-limit check failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      INTERNAL_ERROR_BODY,
      { status: 500 },
    );
  }

  let result;
  try {
    result = await deleteAccount({
      userId: user.id,
      email: user.email,
      password: parsed.data.password,
    });
  } catch (err) {
    // `deleteAccount` reports failures as results; this is a last-resort net.
    console.error(
      "DELETE /api/account: unexpected failure:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      INTERNAL_ERROR_BODY,
      { status: 500 },
    );
  }

  if (!result.ok) {
    if (result.reason === "reauth_failed") {
      return NextResponse.json(
        { error: "Incorrect password.", code: "reauth_failed" },
        { status: 403 },
      );
    }
    return NextResponse.json(
      INTERNAL_ERROR_BODY,
      { status: 500 },
    );
  }

  // Step 5: the account is gone; clear the session cookies. Never throws.
  await clearAuthSession();

  return new NextResponse(null, { status: 204 });
}
