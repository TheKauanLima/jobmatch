import { NextResponse } from "next/server";

import { jobListingRpcErrorResponse } from "@/lib/api/jobListingErrors";
import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  deleteJobListing,
  getJobDescriptionById,
  JobListingRpcError,
  updateJobListing,
} from "@/lib/supabase/queries/jobDescriptions";
import { jobDescriptionUpdateSchema } from "@/lib/validation/schemas";
import { toJobDescription } from "@/types/domain";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/job-descriptions/:id — single job description detail. Auth
 * required. Read through RLS (docs/ARCHITECTURE.md §13.13.4): another
 * user's private listing returns `404`, exactly like a missing row. Shared
 * rows (and the caller's own private ones) are returned **even if
 * soft-deleted, closed or a hidden duplicate** (§10, §13.6.5): links from
 * existing matches and recommendations must keep resolving; only
 * listing/search hide those rows.
 *
 * `requirements` (§13.13.4) arrives with job requirement extraction (M2.2).
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
 * PATCH /api/job-descriptions/:id — edit a job listing you submitted,
 * through the `update_job_listing` RPC (docs/ARCHITECTURE.md §10,
 * §13.13.4). Auth required.
 *
 * - The row is first read through RLS: missing, or another user's private
 *   listing → `404`. A visible row the caller didn't submit (or an external
 *   row) → `403` (§10: shared data is public via `GET`).
 * - Body as §10 plus `"visibility"?: "shared"`: `private → shared` is
 *   allowed; `"private"` on a shared row → `400 {code:'visibility_downgrade'}`.
 * - A content change (title/company/description) charges
 *   `job_listing_update`: `429 {code:'rate_limited', kind:'job_listing_update'}`
 *   at the daily limit. Editing a shared listing extends its expiry.
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
    const updated = await updateJobListing(supabase, {
      id,
      patch: {
        title: parsed.data.title,
        company: parsed.data.company,
        description: parsed.data.description,
        sourceUrl: parsed.data.source_url,
        location: parsed.data.location,
        level: parsed.data.level,
        visibility: parsed.data.visibility,
      },
    });

    return NextResponse.json({
      job_description: toJobDescription(updated, user.id),
    });
  } catch (err) {
    if (err instanceof JobListingRpcError) {
      return jobListingRpcErrorResponse(err, {
        route: "PATCH /api/job-descriptions/:id",
        failureMessage: "Failed to update job description.",
        notFoundStatus: 403,
      });
    }
    console.error(
      "PATCH /api/job-descriptions/:id: failed to update job description:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to update job description." },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/job-descriptions/:id — delete a job listing you submitted,
 * through the `delete_job_listing` RPC (docs/ARCHITECTURE.md §10,
 * §13.13.4). Same pre-check as `PATCH` (`404` missing or another user's
 * private listing, `403` a visible row you didn't submit).
 *
 * - Private listing → hard delete (cascade removes your own fit checks on
 *   it), `204`.
 * - Shared listing → soft delete (`deleted_at`; other users' matches keep
 *   resolving), `204`. Idempotent.
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
    await deleteJobListing(supabase, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof JobListingRpcError) {
      return jobListingRpcErrorResponse(err, {
        route: "DELETE /api/job-descriptions/:id",
        failureMessage: "Failed to delete job description.",
        notFoundStatus: 403,
      });
    }
    console.error(
      "DELETE /api/job-descriptions/:id: failed to delete job description:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to delete job description." },
      { status: 500 },
    );
  }
}
