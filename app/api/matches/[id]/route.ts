import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getMatchById } from "@/lib/supabase/queries/matches";
import { toMatch } from "@/types/domain";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/matches/:id — single match detail, owner only, per
 * docs/ARCHITECTURE.md §2. `404` if not found or not owned by the caller
 * (never `403`, to avoid leaking existence of other users' rows).
 */
export async function GET(_request: Request, { params }: RouteContext) {
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

  try {
    const match = await getMatchById(supabase, user.id, id);
    if (!match) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    return NextResponse.json({ match: toMatch(match, match.job_description) });
  } catch (err) {
    console.error(
      "GET /api/matches/:id failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to fetch match." },
      { status: 500 },
    );
  }
}
