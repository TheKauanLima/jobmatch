import { NextResponse } from "next/server";

import { jobListingRpcErrorResponse } from "@/lib/api/jobListingErrors";
import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  createJobListing,
  decodeJobDescriptionOffsetCursor,
  encodeJobDescriptionCursor,
  encodeJobDescriptionOffsetCursor,
  isJobDescriptionScope,
  JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH,
  JOB_DESCRIPTIONS_DEFAULT_LIMIT,
  JOB_DESCRIPTIONS_MAX_LIMIT,
  JobListingRpcError,
  listJobDescriptions,
  searchJobDescriptions,
  type JobDescriptionScope,
} from "@/lib/supabase/queries/jobDescriptions";
import {
  JOB_LISTING_DEFAULT_VISIBILITY,
  jobDescriptionCreateSchema,
} from "@/lib/validation/schemas";
import { toJobDescription } from "@/types/domain";

/**
 * GET /api/job-descriptions — list job descriptions. `?scope=shared|mine`
 * (docs/ARCHITECTURE.md §13.13.4, default `shared`): `shared` returns active
 * shared listings only (no closed, duplicate, soft-deleted or private rows,
 * not even the caller's own private ones); `mine` returns everything the
 * caller submitted (shared and private, closed and soft-deleted included,
 * duplicates excluded). Any other value is a 400. `?q=` and `?level=` work
 * in both scopes, and both scopes use keyset pagination without `q`.
 * Other query params per docs/ARCHITECTURE.md §2/§9.3: `?limit=20`, `?level=<level>` (added per §7
 * for external-listing ingestion — e.g. `Internship`/`Entry Level`; omitted/
 * empty means no filter, combinable with `?q=`), `?q=<term>` (added per §9,
 * full-text search over `title`/`company`/`description`/`location` — see
 * `lib/supabase/queries/jobDescriptions.ts#searchJobDescriptions`; omitted,
 * or empty/whitespace-only after trimming, means no search filter and falls
 * back to the plain listing below; capped at
 * `JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH` characters, `400` if exceeded),
 * and `?cursor=<opaque token>` whose meaning depends on whether `q` is
 * present on the same request (§9.2): without `q`, keyset pagination
 * ordered `created_at desc, id desc` exactly as before (`id` tiebreaker
 * keeps pagination correct when rows share a `created_at`); with `q`,
 * offset pagination ordered by relevance. A cursor from the other mode's
 * encoding — or any other malformed cursor — is treated as "no cursor"
 * (first page). Auth required (any authenticated user — shared data, not
 * owner-scoped).
 */
export async function GET(request: Request) {
  try {
    const { user } = await requireSession();
    const supabase = await createClient();

    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const cursorParam = url.searchParams.get("cursor");
    const levelParam = url.searchParams.get("level");
    const qParam = url.searchParams.get("q");
    const scopeParam = url.searchParams.get("scope");

    let scope: JobDescriptionScope = "shared";
    if (scopeParam !== null && scopeParam !== "") {
      if (!isJobDescriptionScope(scopeParam)) {
        return NextResponse.json(
          { error: "scope must be 'shared' or 'mine'.", code: "validation_failed" },
          { status: 400 },
        );
      }
      scope = scopeParam;
    }

    let limit = JOB_DESCRIPTIONS_DEFAULT_LIMIT;
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
        return NextResponse.json(
          { error: "limit must be a positive integer." },
          { status: 400 },
        );
      }
      limit = Math.min(parsed, JOB_DESCRIPTIONS_MAX_LIMIT);
    }

    const trimmedQuery = qParam?.trim() ?? "";
    if (trimmedQuery.length > JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH) {
      return NextResponse.json(
        {
          error: `q must be at most ${JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH} characters.`,
        },
        { status: 400 },
      );
    }

    if (trimmedQuery.length > 0) {
      const offset = cursorParam
        ? (decodeJobDescriptionOffsetCursor(cursorParam) ?? 0)
        : 0;

      const { items, hasMore } = await searchJobDescriptions(supabase, {
        query: trimmedQuery,
        limit,
        offset,
        level: levelParam,
        scope,
      });

      const next_cursor = hasMore
        ? encodeJobDescriptionOffsetCursor(offset + items.length)
        : null;

      return NextResponse.json({
        job_descriptions: items.map((row) => toJobDescription(row, user.id)),
        next_cursor,
      });
    }

    const { items, hasMore } = await listJobDescriptions(supabase, {
      limit,
      cursor: cursorParam,
      level: levelParam,
      scope,
      // The session user's id, never request input (§13.15 item 3).
      callerId: user.id,
    });

    const lastItem = items[items.length - 1];
    const next_cursor =
      hasMore && lastItem ? encodeJobDescriptionCursor(lastItem) : null;

    return NextResponse.json({
      job_descriptions: items.map((row) => toJobDescription(row, user.id)),
      next_cursor,
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    console.error(
      "GET /api/job-descriptions failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to list job descriptions." },
      { status: 500 },
    );
  }
}

/**
 * POST /api/job-descriptions — submit a job listing through the
 * `create_job_listing` RPC (docs/ARCHITECTURE.md §13.13.4; direct inserts
 * are revoked since 0009). The RPC records `submitted_by = auth.uid()`,
 * applies the visibility (`shared` by default until M4.3 makes it
 * required; `private` rows are visible only to the submitter), and charges
 * `job_listing_create` (429 at the daily limit). Auth required.
 */
export async function POST(request: Request) {
  let user;
  try {
    ({ user } = await requireSession());
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Expected a JSON request body." },
      { status: 400 },
    );
  }

  const parsed = jobDescriptionCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  try {
    const supabase = await createClient();
    const jobDescription = await createJobListing(supabase, {
      title: parsed.data.title,
      company: parsed.data.company,
      description: parsed.data.description,
      sourceUrl: parsed.data.source_url,
      location: parsed.data.location,
      level: parsed.data.level,
      visibility: parsed.data.visibility ?? JOB_LISTING_DEFAULT_VISIBILITY,
    });

    return NextResponse.json(
      { job_description: toJobDescription(jobDescription, user.id) },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof JobListingRpcError) {
      return jobListingRpcErrorResponse(err, {
        route: "POST /api/job-descriptions",
        failureMessage: "Failed to save job description.",
        notFoundStatus: 404,
      });
    }
    console.error(
      "POST /api/job-descriptions: failed to save job description:",
      err instanceof Error ? err.message : "unknown error",
    );

    return NextResponse.json(
      { error: "Failed to save job description." },
      { status: 500 },
    );
  }
}
