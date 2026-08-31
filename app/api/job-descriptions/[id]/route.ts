import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getJobDescriptionById } from "@/lib/supabase/queries/jobDescriptions";
import { toJobDescription } from "@/types/domain";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/job-descriptions/:id — single job description detail. Auth
 * required (any authenticated user), but no ownership check — shared data,
 * per docs/ARCHITECTURE.md §2. `404` if the row doesn't exist at all.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    await requireSession();
    const { id } = await params;
    const supabase = await createClient();

    const jobDescription = await getJobDescriptionById(supabase, id);
    if (!jobDescription) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    return NextResponse.json({
      job_description: toJobDescription(jobDescription),
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
