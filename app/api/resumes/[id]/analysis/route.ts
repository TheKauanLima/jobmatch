import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getResumeById } from "@/lib/supabase/queries/resumes";
import { getLatestAnalysis } from "@/lib/supabase/queries/analyses";
import { toResumeAnalysis } from "@/types/domain";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/resumes/:id/analysis — latest analysis for a resume, owner only,
 * per docs/ARCHITECTURE.md §2. `404` if the resume doesn't exist/isn't
 * owned by the caller, or if it exists but has no analysis yet (client
 * should prompt to run `POST /api/resumes/:id/analyze`).
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

    const analysis = await getLatestAnalysis(supabase, user.id, id);
    if (!analysis) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    return NextResponse.json({ analysis: toResumeAnalysis(analysis) });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    console.error(
      "GET /api/resumes/:id/analysis failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to fetch analysis." },
      { status: 500 },
    );
  }
}
