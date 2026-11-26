import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getJobDescriptionFacets } from "@/lib/supabase/queries/jobDescriptions";

/**
 * GET /api/job-descriptions/facets — global board-filter counts
 * (docs/ARCHITECTURE.md §7.8.6). The static segment takes precedence over
 * `[id]`. Auth required (same 401 as the list route).
 *
 * 200: `{ categories: { [slug]: n }, states: { [code]: n }, remote: n }`,
 * over all active rows, independent of any other filter; zero counts are
 * absent. Used only to hide states with no listings and mark empty fields,
 * so a 5-minute private cache is fine. 500: `{ error: "Failed to load job filters." }`.
 */
export async function GET() {
  try {
    await requireSession();
    const supabase = await createClient();
    const facets = await getJobDescriptionFacets(supabase);

    return NextResponse.json(facets, {
      headers: { "Cache-Control": "private, max-age=300" },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    console.error(
      "GET /api/job-descriptions/facets failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to load job filters." },
      { status: 500 },
    );
  }
}
