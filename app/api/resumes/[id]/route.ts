import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { deleteResume, getResumeById } from "@/lib/supabase/queries/resumes";
import { deleteResumeFile } from "@/lib/storage/resumeFiles";
import { toResumeDetail } from "@/types/domain";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/resumes/:id — resume detail, owner only.
 * Response shape per docs/ARCHITECTURE.md §2 (full resume row including
 * `extracted_text`, minus internal-only fields — see `types/domain.ts`).
 * `404` (not `403`) if the resume doesn't exist or isn't owned by the
 * caller, so we don't leak existence of other users' rows.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { user } = await requireSession();
    const { id } = await params;
    const supabase = await createClient();

    const resume = await getResumeById(supabase, user.id, id);
    if (!resume) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    return NextResponse.json({ resume: toResumeDetail(resume) });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    console.error(
      "GET /api/resumes/:id failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to fetch resume." },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/resumes/:id — delete a resume: its Storage object and its
 * `resumes` row (analyses/matches cascade via the FK in
 * supabase/migrations/0001_init.sql). Deletes the Storage object first —
 * if that fails, the DB row is left intact so the delete can be retried,
 * rather than risking a DB row surviving with its file already gone.
 */
export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    const { user } = await requireSession();
    const { id } = await params;
    const supabase = await createClient();

    const resume = await getResumeById(supabase, user.id, id);
    if (!resume) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    try {
      await deleteResumeFile(supabase, resume.storage_path);
    } catch (err) {
      console.error(
        "DELETE /api/resumes/:id: failed to delete Storage object:",
        err instanceof Error ? err.message : "unknown error",
      );
      return NextResponse.json(
        { error: "Failed to delete resume file." },
        { status: 500 },
      );
    }

    await deleteResume(supabase, user.id, id);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    console.error(
      "DELETE /api/resumes/:id failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to delete resume." },
      { status: 500 },
    );
  }
}
