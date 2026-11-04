import { NextResponse } from "next/server";

import { clearAuthSession } from "@/lib/account/clearAuthSession";
import { deleteAccount } from "@/lib/account/deleteAccount";
import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { accountDeleteSchema } from "@/lib/validation/schemas";

/**
 * Paginated Storage purge + Auth admin delete can take a while for an account
 * with many objects (docs/ARCHITECTURE.md §13.13.7).
 */
export const maxDuration = 60;

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
 *   - `500 { error, code: "internal_error" }` — a deletion step failed. When
 *     this happens before the auth user is deleted (always, by construction
 *     of `deleteAccount`), the account still exists and the request can
 *     simply be retried.
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
      { error: "Failed to delete account.", code: "internal_error" },
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
      { error: "Failed to delete account.", code: "internal_error" },
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
      {
        error:
          "We couldn't finish deleting your account. Your account still exists — please try again.",
        code: "internal_error",
      },
      { status: 500 },
    );
  }

  // Step 5: the account is gone; clear the session cookies. Never throws.
  await clearAuthSession();

  return new NextResponse(null, { status: 204 });
}
