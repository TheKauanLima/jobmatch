import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { deriveJobFacets } from "@/lib/jobs/facets";
import { createClient } from "@/lib/supabase/server";
import {
  createJobDescription,
  decodeJobDescriptionOffsetCursor,
  encodeJobDescriptionCursor,
  encodeJobDescriptionOffsetCursor,
  JobDescriptionQueryError,
  listJobDescriptions,
  searchJobDescriptions,
} from "@/lib/supabase/queries/jobDescriptions";
import {
  jobDescriptionCreateSchema,
  jobDescriptionListQuerySchema,
} from "@/lib/validation/schemas";
import { toJobDescription } from "@/types/domain";

/**
 * GET /api/job-descriptions — list shared job descriptions. Query params per
 * docs/ARCHITECTURE.md §2/§9.3/§7.8.6, validated by
 * `jobDescriptionListQuerySchema` (400 `{ error }` with the first issue's
 * message on failure; an empty string means the param is absent):
 * `q` (full-text search, ≤ 200 chars), `level`, `category` (field slug),
 * `location` (`remote` or a US state/DC code), `sort` (`relevance` |
 * `recent`; relevance requires `q`), `limit` (capped at 100), and
 * `cursor`. All filters combine with AND, with or without `q`.
 *
 * Cursor meaning depends on whether `q` is present (§9.2): without `q`,
 * keyset pagination ordered `listed_at desc, id desc` (`listed_at =
 * coalesce(posted_at, created_at)`); with `q`, offset pagination (ordered
 * by relevance or, with `sort=recent`, by `listed_at`). A cursor from the
 * other mode's encoding, or any other malformed cursor, is treated as "no
 * cursor" (first page). Auth required (any authenticated user — shared
 * data, not owner-scoped).
 */
export async function GET(request: Request) {
  try {
    const { user } = await requireSession();
    const supabase = await createClient();

    const url = new URL(request.url);
    const parsedQuery = jobDescriptionListQuerySchema.safeParse(
      Object.fromEntries(url.searchParams),
    );
    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: parsedQuery.error.issues[0]?.message ?? "Invalid query parameters." },
        { status: 400 },
      );
    }
    const { q, level, category, location, sort, limit, cursor } = parsedQuery.data;
    const filters = { level, category, location };

    if (q !== null) {
      const offset = cursor ? (decodeJobDescriptionOffsetCursor(cursor) ?? 0) : 0;

      const { items, hasMore } = await searchJobDescriptions(supabase, {
        query: q,
        limit,
        offset,
        sort,
        ...filters,
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
      cursor,
      ...filters,
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
    // Facets are always derived server-side (§7.8.4); the body can't set them.
    const facets = deriveJobFacets({
      title: parsed.data.title,
      location: parsed.data.location ?? null,
    });
    const jobDescription = await createJobDescription(supabase, {
      submittedBy: user.id,
      title: parsed.data.title,
      company: parsed.data.company,
      description: parsed.data.description,
      sourceUrl: parsed.data.source_url,
      location: parsed.data.location,
      level: parsed.data.level,
      ...facets,
    });

    return NextResponse.json(
      { job_description: toJobDescription(jobDescription, user.id) },
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
