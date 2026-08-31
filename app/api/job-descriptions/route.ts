import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  createJobDescription,
  encodeJobDescriptionCursor,
  JOB_DESCRIPTIONS_DEFAULT_LIMIT,
  JOB_DESCRIPTIONS_MAX_LIMIT,
  JobDescriptionQueryError,
  listJobDescriptions,
} from "@/lib/supabase/queries/jobDescriptions";
import { jobDescriptionCreateSchema } from "@/lib/validation/schemas";
import { toJobDescription } from "@/types/domain";

/**
 * GET /api/job-descriptions — list shared job descriptions, cursor-paginated
 * on `created_at desc, id desc` (the `id` tiebreaker keeps pagination
 * correct when rows share a `created_at` — see
 * `lib/supabase/queries/jobDescriptions.ts`). Query params per
 * docs/ARCHITECTURE.md §2: `?limit=20&cursor=<opaque token from a previous
 * response's next_cursor>`. Auth required (any authenticated user — shared
 * data, not owner-scoped).
 */
export async function GET(request: Request) {
  try {
    await requireSession();
    const supabase = await createClient();

    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const cursorParam = url.searchParams.get("cursor");

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

    const { items, hasMore } = await listJobDescriptions(supabase, {
      limit,
      cursor: cursorParam,
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
