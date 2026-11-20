import { NextResponse } from "next/server";

import "@/lib/tasks/registerUsageSink";
import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getResumeById } from "@/lib/supabase/queries/resumes";
import { getLatestAnalysis } from "@/lib/supabase/queries/analyses";
import { getJobDescriptionById } from "@/lib/supabase/queries/jobDescriptions";
import {
  createMatch,
  encodeMatchCursor,
  listMatchesForResume,
  listRecentMatchesForUser,
  RECENT_MATCHES_DEFAULT_LIMIT,
  RECENT_MATCHES_MAX_LIMIT,
} from "@/lib/supabase/queries/matches";
import { DAILY_RATE_LIMITS, checkRateLimit } from "@/lib/claude/rateLimit";
import { matchResumeToJob } from "@/lib/claude/prompts/matchResumeToJob";
import { ClaudeApiError } from "@/lib/claude/errors";
import { SYNC_ROUTE_CLAUDE_DEADLINE_MS } from "@/lib/claude/config";
import { matchCreateSchema } from "@/lib/validation/schemas";
import { toMatch, toRecentMatch } from "@/types/domain";

/**
 * Must exceed `SYNC_ROUTE_CLAUDE_DEADLINE_MS` (270 s), so POST's deadline
 * always fires first and the client gets the route's JSON 502, never a
 * platform 504. Matches app/api/worker/tick/route.ts. (GET is unaffected
 * in practice; it finishes in milliseconds.)
 */
export const maxDuration = 300;

/**
 * GET /api/matches — two modes, both fully scoped to the caller (`user.id`
 * from `requireSession()`, never a request param):
 *
 * - `?resume_id=:id` — matches for one of the caller's own resumes, per
 *   docs/ARCHITECTURE.md §2. Ownership of `resume_id` is verified explicitly
 *   (404 if not found/not owned) before listing, rather than trusting
 *   `listMatchesForResume`'s own `user_id` scoping alone to distinguish "no
 *   matches yet" from "not your resume" — keeps the 404 behavior consistent
 *   with every other ownership check in the API.
 * - no `resume_id` — the caller's own most recent matches **across all**
 *   their resumes (optionally `?limit=`, default/max per
 *   `RECENT_MATCHES_DEFAULT_LIMIT`/`RECENT_MATCHES_MAX_LIMIT`), added for the
 *   dashboard's "Latest matches" panel and, per docs/ARCHITECTURE.md §11,
 *   extended with `?cursor=<opaque token>` for the full `/matches` history
 *   page — keyset pagination ordered `created_at desc, id desc`, encoded/
 *   decoded by `encodeMatchCursor`/`decodeMatchCursor` in
 *   `lib/supabase/queries/matches.ts`. Omitting `cursor` returns the first
 *   page; a malformed cursor is treated as "no cursor" (first page), same
 *   convention as `GET /api/job-descriptions`. `next_cursor` in the response
 *   follows the same "pass it back verbatim" contract, `null` once there are
 *   no more rows. Each result includes a `resume` summary (absent from the
 *   `resume_id`-scoped shape, since that mode's caller already knows which
 *   resume they queried) — see `types/domain.ts#RecentMatch`. This is NOT the
 *   `job_description_id`-only enumeration mode ARCHITECTURE.md §2
 *   deliberately excludes (that would let a caller see *other users'*
 *   matches against a shared job posting) — this mode takes no filter beyond
 *   the caller's own `user.id`, so it can only ever return rows the caller
 *   already owns, same as the `resume_id`-scoped mode. See
 *   `listRecentMatchesForUser`'s docstring for the full reasoning.
 */
export async function GET(request: Request) {
  let user;
  try {
    ({ user } = await requireSession());
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const url = new URL(request.url);
  const resumeId = url.searchParams.get("resume_id");
  const supabase = await createClient();

  if (!resumeId) {
    const limitParam = url.searchParams.get("limit");
    const cursorParam = url.searchParams.get("cursor");
    let limit = RECENT_MATCHES_DEFAULT_LIMIT;
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
        return NextResponse.json(
          { error: "limit must be a positive integer." },
          { status: 400 },
        );
      }
      limit = Math.min(parsed, RECENT_MATCHES_MAX_LIMIT);
    }

    try {
      const { items, hasMore } = await listRecentMatchesForUser(supabase, user.id, {
        limit,
        cursor: cursorParam,
      });

      const lastItem = items[items.length - 1];
      const next_cursor = hasMore && lastItem ? encodeMatchCursor(lastItem) : null;

      return NextResponse.json({
        matches: items.map((row) => toRecentMatch(row, row.job_description, row.resume)),
        next_cursor,
      });
    } catch (err) {
      console.error(
        "GET /api/matches (recent) failed:",
        err instanceof Error ? err.message : "unknown error",
      );
      return NextResponse.json(
        { error: "Failed to list matches." },
        { status: 500 },
      );
    }
  }

  try {
    const resume = await getResumeById(supabase, user.id, resumeId);
    if (!resume) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const matches = await listMatchesForResume(supabase, user.id, resumeId);

    return NextResponse.json({
      matches: matches.map((row) => toMatch(row, row.job_description)),
    });
  } catch (err) {
    console.error(
      "GET /api/matches failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to list matches." },
      { status: 500 },
    );
  }
}

/**
 * POST /api/matches — run a Claude match assessment between one of the
 * caller's resumes and a job description, per docs/ARCHITECTURE.md §2.
 *
 * Flow (exact order per the architecture contract): auth -> validate body ->
 * resume ownership check (404) -> latest analysis exists (400, "must be
 * analyzed before matching") -> job description exists (404) -> job
 * description not soft-deleted (400, per docs/ARCHITECTURE.md §10.3 — a
 * removed posting can't become the target of a *new* match, though existing
 * matches against it keep working) -> daily rate-limit check (429) -> call
 * Claude (structured output + semantic validation) -> insert a `matches` row -> respond `201`
 * with the joined job description summary inlined.
 *
 * Never logs resume/job-description text or Claude response content — only
 * error messages, per the no-PII-in-logs rule (see CLAUDE.md).
 */
export async function POST(request: Request) {
  // Started first, so time spent before Claude counts against it too (see
  // `maxDuration` above). Bounds the whole Claude step, retries included.
  const claudeDeadline = AbortSignal.timeout(SYNC_ROUTE_CLAUDE_DEADLINE_MS);

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

  const parsed = matchCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  const { resume_id: resumeId, job_description_id: jobDescriptionId } = parsed.data;
  const supabase = await createClient();

  let resume;
  try {
    resume = await getResumeById(supabase, user.id, resumeId);
  } catch (err) {
    console.error(
      "POST /api/matches: failed to fetch resume:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ error: "Failed to create match." }, { status: 500 });
  }

  if (!resume) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let analysis;
  try {
    analysis = await getLatestAnalysis(supabase, user.id, resumeId);
  } catch (err) {
    console.error(
      "POST /api/matches: failed to fetch latest analysis:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ error: "Failed to create match." }, { status: 500 });
  }

  if (!analysis || !resume.extracted_text || resume.extracted_text.trim().length === 0) {
    return NextResponse.json(
      { error: "Resume must be analyzed before matching." },
      { status: 400 },
    );
  }

  let jobDescription;
  try {
    jobDescription = await getJobDescriptionById(supabase, jobDescriptionId);
  } catch (err) {
    console.error(
      "POST /api/matches: failed to fetch job description:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ error: "Failed to create match." }, { status: 500 });
  }

  if (!jobDescription) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (jobDescription.deleted_at) {
    return NextResponse.json(
      { error: "This job description has been removed and can't be matched against." },
      { status: 400 },
    );
  }

  try {
    const rateLimitResult = await checkRateLimit(supabase, user.id, {
      kind: "match",
      limit: DAILY_RATE_LIMITS.match,
    });

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        {
          error: "Daily match limit reached. Try again tomorrow.",
          retry_after: rateLimitResult.retryAfter,
        },
        { status: 429 },
      );
    }
  } catch (err) {
    console.error(
      "POST /api/matches: rate limit check failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ error: "Failed to create match." }, { status: 500 });
  }

  let match;
  try {
    // Structured output + semantic validation, with a single retry on
    // invalid output, all happen inside `matchResumeToJob` (§13.5.2). This
    // replaces v1's MAX_MATCH_ATTEMPTS loop.
    const outcome = await matchResumeToJob(
      resume.extracted_text,
      jobDescription.description,
      { userId: user.id, signal: claudeDeadline },
    );

    match = await createMatch(supabase, {
      resumeId,
      jobDescriptionId,
      userId: user.id,
      model: outcome.model,
      result: outcome.value,
    });
  } catch (err) {
    // Every Claude-layer failure is a ClaudeApiError subclass. `code` and
    // `message` are PII-free by construction (lib/claude/errors.ts).
    if (err instanceof ClaudeApiError) {
      console.error(
        "POST /api/matches: Claude match assessment failed:",
        err.code,
        err.message,
      );
      return NextResponse.json(
        { error: "Match assessment failed. Please try again." },
        { status: 502 },
      );
    }

    console.error(
      "POST /api/matches: unexpected failure:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ error: "Failed to create match." }, { status: 500 });
  }

  return NextResponse.json(
    {
      match: toMatch(match, {
        id: jobDescription.id,
        title: jobDescription.title,
        company: jobDescription.company,
        deleted_at: jobDescription.deleted_at,
      }),
    },
    { status: 201 },
  );
}
