import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  getJobDescriptionById,
  JobDescriptionQueryError,
  softDeleteJobDescription,
  updateJobDescription,
} from "@/lib/supabase/queries/jobDescriptions";
import { jobDescriptionUpdateSchema } from "@/lib/validation/schemas";
import { toJobDescription } from "@/types/domain";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/job-descriptions/:id — single job description detail. Auth
 * required (any authenticated user), but no ownership check — shared data,
 * per docs/ARCHITECTURE.md §2. Returns the full row **even if `deleted_at`
 * is set** (per §10) — a link from an existing `matches` row or from the
 * submitter's own view must keep resolving; only listing/search hide a
 * deleted posting. `404` if the row doesn't exist at all.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { user } = await requireSession();
    const { id } = await params;
    const supabase = await createClient();

    const jobDescription = await getJobDescriptionById(supabase, id);
    if (!jobDescription) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    return NextResponse.json({
      job_description: toJobDescription(jobDescription, user.id),
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    console.error(
      "GET /api/job-descriptions/:id failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to fetch job description." },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/job-descriptions/:id — edit a job description you submitted.
 * Added per docs/ARCHITECTURE.md §10. Auth required; caller must be the
 * row's submitter (`submitted_by = auth.uid()` and `source = 'user'`) —
 * `403` otherwise (not `404`: existence of shared data is already public
 * via `GET`, so there's nothing to hide by using `404` here the way
 * private-resource routes do). `404` if the row doesn't exist at all —
 * checked explicitly up front so a nonexistent id and an unowned id don't
 * collapse into the same status code.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  let user;
  try {
    ({ user } = await requireSession());
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const { id } = await params;
  const supabase = await createClient();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Expected a JSON request body." },
      { status: 400 },
    );
  }

  const parsed = jobDescriptionUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  let existing;
  try {
    existing = await getJobDescriptionById(supabase, id);
  } catch (err) {
    console.error(
      "PATCH /api/job-descriptions/:id: failed to fetch job description:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to update job description." },
      { status: 500 },
    );
  }

  if (!existing) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (existing.submitted_by !== user.id || existing.source !== "user") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  try {
    const updated = await updateJobDescription(supabase, {
      id,
      submittedBy: user.id,
      patch: {
        title: parsed.data.title,
        company: parsed.data.company,
        description: parsed.data.description,
        sourceUrl: parsed.data.source_url,
        location: parsed.data.location,
        level: parsed.data.level,
      },
    });

    if (!updated) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    return NextResponse.json({
      job_description: toJobDescription(updated, user.id),
    });
  } catch (err) {
    const message =
      err instanceof JobDescriptionQueryError ? err.message : "unknown error";
    console.error(
      "PATCH /api/job-descriptions/:id: failed to update job description:",
      message,
    );
    return NextResponse.json(
      { error: "Failed to update job description." },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/job-descriptions/:id — soft-delete (hide) a job description
 * you submitted. Added per docs/ARCHITECTURE.md §10. Same ownership rule as
 * `PATCH` (`403` if not the caller's own `source='user'` row, `404` if the
 * row doesn't exist). Sets `deleted_at = now()` — does **not** delete the
 * row or touch any `matches` referencing it. Idempotent: deleting an
 * already-deleted row just returns `204` again.
 */
export async function DELETE(_request: Request, { params }: RouteContext) {
  let user;
  try {
    ({ user } = await requireSession());
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const { id } = await params;
  const supabase = await createClient();

  let existing;
  try {
    existing = await getJobDescriptionById(supabase, id);
  } catch (err) {
    console.error(
      "DELETE /api/job-descriptions/:id: failed to fetch job description:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to delete job description." },
      { status: 500 },
    );
  }

  if (!existing) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (existing.submitted_by !== user.id || existing.source !== "user") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  try {
    const deleted = await softDeleteJobDescription(supabase, {
      id,
      submittedBy: user.id,
    });

    if (!deleted) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const message =
      err instanceof JobDescriptionQueryError ? err.message : "unknown error";
    console.error(
      "DELETE /api/job-descriptions/:id: failed to delete job description:",
      message,
    );
    return NextResponse.json(
      { error: "Failed to delete job description." },
      { status: 500 },
    );
  }
}
