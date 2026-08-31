import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getResumeById } from "@/lib/supabase/queries/resumes";
import { getLatestAnalysis } from "@/lib/supabase/queries/analyses";
import { getJobDescriptionById } from "@/lib/supabase/queries/jobDescriptions";
import {
  createMatch,
  listMatchesForResume,
} from "@/lib/supabase/queries/matches";
import { DAILY_RATE_LIMITS, checkRateLimit } from "@/lib/claude/rateLimit";
import { matchResumeToJob } from "@/lib/claude/prompts/matchResumeToJob";
import { ClaudeResponseValidationError, parseMatchResponse } from "@/lib/claude/parse";
import { ClaudeApiError } from "@/lib/claude/client";
import { matchCreateSchema } from "@/lib/validation/schemas";
import { toMatch } from "@/types/domain";

/**
 * GET /api/matches?resume_id=:id — list matches for one of the caller's own
 * resumes, per docs/ARCHITECTURE.md §2. `resume_id` is required; there is
 * deliberately no listing mode without it (see the route's docs/ARCHITECTURE.md
 * note: a `job_description_id`-only mode would let a user enumerate match
 * results tied to *other* users' resumes against a shared job description,
 * breaking the privacy model even though each individual `matches` row is
 * RLS-protected).
 *
 * Ownership of `resume_id` is verified explicitly (404 if not found/not
 * owned) before listing, rather than trusting `listMatchesForResume`'s own
 * `user_id` scoping alone to distinguish "no matches yet" from "not your
 * resume" — this keeps the 404 behavior consistent with every other
 * ownership check in the API (see docs/ARCHITECTURE.md §2).
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

  if (!resumeId) {
    return NextResponse.json(
      { error: "resume_id query parameter is required." },
      { status: 400 },
    );
  }

  const supabase = await createClient();

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
 * analyzed before matching") -> job description exists (404) -> daily
 * rate-limit check (429) -> call Claude -> validate its response -> insert a
 * `matches` row -> respond `201` with the joined job description summary
 * inlined.
 *
 * Never logs resume/job-description text or Claude response content — only
 * error messages, per the no-PII-in-logs rule (see CLAUDE.md).
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
    const message = await matchResumeToJob(
      resume.extracted_text,
      jobDescription.description,
    );
    const result = parseMatchResponse(message);

    match = await createMatch(supabase, {
      resumeId,
      jobDescriptionId,
      userId: user.id,
      model: message.model,
      result,
    });
  } catch (err) {
    if (
      err instanceof ClaudeApiError ||
      err instanceof ClaudeResponseValidationError
    ) {
      console.error("POST /api/matches: Claude match assessment failed:", err.message);
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
      }),
    },
    { status: 201 },
  );
}
