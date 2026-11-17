import { NextResponse } from "next/server";

import { nextUtcMidnight } from "@/lib/rateLimit";
import type { JobListingRpcError } from "@/lib/supabase/queries/jobDescriptions";

/**
 * Maps a listing-RPC failure to the §13.13 error envelope for the
 * `/api/job-descriptions` write routes (POST, PATCH, DELETE):
 *
 * - `rate_limited:<kind>` → 429 `{ error, code: "rate_limited", kind, retry_after }`
 *   (`retry_after` = next UTC midnight, as everywhere else, §13.9.3)
 * - `visibility_downgrade` → 400 `{ error, code: "visibility_downgrade" }`
 * - `validation_*` → 400 `{ error, code: "validation_failed" }` (the route's
 *   zod check normally catches these first)
 * - `unauthenticated` → 401
 * - `not_found_or_not_owner` → `notFoundStatus` (the route already
 *   answered 404/403 from its RLS pre-check; reaching the RPC error means
 *   the row changed in between, which the routes treat as 403 like v1)
 * - anything else → 500 with the route's generic copy, logged without PII.
 *
 * Server-only (route handlers).
 */
export function jobListingRpcErrorResponse(
  err: JobListingRpcError,
  options: { route: string; failureMessage: string; notFoundStatus: 403 | 404 },
): NextResponse {
  switch (err.reason) {
    case "rate_limited":
      return NextResponse.json(
        {
          error:
            err.rateLimitKind === "job_listing_update"
              ? "You've reached today's limit for editing job listings. Try again after 00:00 UTC."
              : "You've reached today's limit for submitting job listings. Try again after 00:00 UTC.",
          code: "rate_limited",
          kind: err.rateLimitKind,
          retry_after: nextUtcMidnight(),
        },
        { status: 429 },
      );
    case "visibility_downgrade":
      return NextResponse.json(
        {
          error: "A shared listing can't be made private: other users may already be using it.",
          code: "visibility_downgrade",
        },
        { status: 400 },
      );
    case "validation":
      return NextResponse.json(
        { error: "Invalid job listing.", code: "validation_failed" },
        { status: 400 },
      );
    case "unauthenticated":
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    case "not_found":
      return options.notFoundStatus === 404
        ? NextResponse.json({ error: "Not found." }, { status: 404 })
        : NextResponse.json({ error: "Forbidden." }, { status: 403 });
    default:
      console.error(`${options.route}: listing RPC failed:`, err.message);
      return NextResponse.json({ error: options.failureMessage }, { status: 500 });
  }
}
