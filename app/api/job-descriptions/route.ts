import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  createJobDescription,
  decodeJobDescriptionOffsetCursor,
  encodeJobDescriptionCursor,
  encodeJobDescriptionOffsetCursor,
  JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH,
  JOB_DESCRIPTIONS_DEFAULT_LIMIT,
  JOB_DESCRIPTIONS_MAX_LIMIT,
  JobDescriptionQueryError,
  listJobDescriptions,
  searchJobDescriptions,
} from "@/lib/supabase/queries/jobDescriptions";
import { jobDescriptionCreateSchema } from "@/lib/validation/schemas";
import { toJobDescription } from "@/types/domain";

/**
 * GET /api/job-descriptions — list shared job descriptions. Query params per
 * docs/ARCHITECTURE.md §2/§9.3: `?limit=20`, `?level=<level>` (added per §7
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
    await requireSession();
    const supabase = await createClient();

    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const cursorParam = url.searchParams.get("cursor");
    const levelParam = url.searchParams.get("level");
    const qParam = url.searchParams.get("q");

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
      });

      const next_cursor = hasMore
        ? encodeJobDescriptionOffsetCursor(offset + items.length)
        : null;

      return NextResponse.json({
        job_descriptions: items.map(toJobDescription),
        next_cursor,
      });
    }

    const { items, hasMore } = await listJobDescriptions(supabase, {
      limit,
      cursor: cursorParam,
      level: levelParam,
    });

    const lastItem = items[items.length - 1];
    const next_cursor =
      hasMore && lastItem ? encodeJobDescriptionCursor(lastItem) : null;

    return NextResponse.json({
      job_descriptions: items.map(toJobDescription),
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
 * POST /api/job-descriptions — submit a job description. Auth required
 * (any authenticated user — this is shared data, not owner-scoped reads,
 * but every row records who submitted it via `submitted_by = auth.uid()`
 * per the `job_descriptions_insert_own` RLS policy).
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
    const jobDescription = await createJobDescription(supabase, {
      submittedBy: user.id,
      title: parsed.data.title,
      company: parsed.data.company,
      description: parsed.data.description,
      sourceUrl: parsed.data.source_url,
      location: parsed.data.location,
      level: parsed.data.level,
    });

    return NextResponse.json(
      { job_description: toJobDescription(jobDescription) },
      { status: 201 },
    );
  } catch (err) {
    const message =
      err instanceof JobDescriptionQueryError ? err.message : "unknown error";
    console.error(
      "POST /api/job-descriptions: failed to save job description:",
      message,
    );

    return NextResponse.json(
      { error: "Failed to save job description." },
      { status: 500 },
    );
  }
}
