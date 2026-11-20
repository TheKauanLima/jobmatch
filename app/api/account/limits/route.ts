import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { getMyRateLimits, RateLimitRpcError } from "@/lib/rateLimit";
import { createClient } from "@/lib/supabase/server";

/** Per-user data: never cache in a shared cache or the browser. */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * GET /api/account/limits — the caller's daily rate limits, per
 * docs/ARCHITECTURE.md §13.13.7 (read by the settings page's `UsageLimits`
 * panel, M1.4b).
 *
 * Response `200`:
 * `{ "limits": [ { kind, daily_limit, used_today, resets_at } ] }`, one entry
 * per kind in `private.rate_limits` (including `account_reauth`), from
 * `get_my_rate_limits()`. `used_today` counts non-refunded events since
 * 00:00 UTC; `resets_at` is the next UTC midnight (ISO).
 *
 * Errors: `401 { error }` without a session; `500 { error, code:
 * "internal_error" }` if the RPC fails.
 *
 * The RPC resolves the user from `auth.uid()` on the cookie-bound client;
 * no user id is ever taken from the request.
 */
export async function GET() {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status, headers: NO_STORE },
      );
    }
    console.error(
      "GET /api/account/limits: session check failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return internalError();
  }

  try {
    const supabase = await createClient();
    const limits = await getMyRateLimits(supabase);
    return NextResponse.json({ limits }, { headers: NO_STORE });
  } catch (err) {
    // The session expired between the check above and the RPC.
    if (err instanceof RateLimitRpcError && err.isUnauthenticated) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: NO_STORE },
      );
    }
    console.error(
      "GET /api/account/limits: failed to load limits:",
      err instanceof Error ? err.message : "unknown error",
    );
    return internalError();
  }
}

function internalError() {
  return NextResponse.json(
    { error: "Failed to load usage limits.", code: "internal_error" },
    { status: 500, headers: NO_STORE },
  );
}
