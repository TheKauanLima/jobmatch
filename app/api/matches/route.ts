import type Anthropic from "@anthropic-ai/sdk";
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
import {
  ClaudeResponseValidationError,
  parseMatchResponse,
  type MatchResult,
} from "@/lib/claude/parse";
import { ClaudeApiError } from "@/lib/claude/client";
import { matchCreateSchema } from "@/lib/validation/schemas";
import { toMatch } from "@/types/domain";

/**
 * Max attempts for the Claude match call (1 initial + up to 3 retries), per
 * a QA-reported bug: Claude's forced tool-use response can itself violate
 * the tool's own declared JSON schema (e.g. `matched_strengths` returned as
 * a string instead of an array, or `gaps` omitted entirely) even though
 * `tool_choice` forces a call to the right tool — this is real,
 * reproducible per-call non-determinism in the model's output, not a bug in
 * our schema or in `parseMatchResponse`'s validation (which is correctly
 * rejecting a non-compliant response — that's the point of validating
 * rather than trusting it).
 *
 * `lib/claude/parse.ts#parseMatchResponse` now also repairs one specific,
 * observed malformation (an XML-`<item>`-tagged string instead of a real
 * array) before validating, which recovers some non-compliant responses
 * without needing a retry at all. That repair does NOT cover every
 * malformation shape, though — live testing against the real Claude API on
 * a long, bullet-heavy resume/job description (the realistic kind QA used)
 * surfaced a second, different corruption (a stray pseudo
 * `<parameter name="...">`-style fragment) in addition to the `<item>`
 * pattern, and even with the repair in place, exhausting 3 total attempts
 * still happened in roughly 1 of every 3 live trials during verification.
 * Bumped from an initial 3 to 4 total attempts for that reason — QA's
 * "retry once, maybe twice" suggestion (2-3 total attempts) was not
 * reliably sufficient on its own for this specific, reproducible failure
 * mode. Still bounded (not unbounded) since each attempt costs a real, slow
 * (~10s) Claude call and this is still fully synchronous per
 * docs/ARCHITECTURE.md §5 — worst case ~40s, within Vercel Pro's default
 * timeout. Deliberately narrow: only retries `ClaudeResponseValidationError`
 * (a schema-compliance failure), never `ClaudeApiError` (a real API/network
 * failure, where immediate retry is less likely to help and could compound
 * an outage/rate-limit).
 */
const MAX_MATCH_ATTEMPTS = 4;

/**
 * Calls Claude for a match assessment and validates the response, retrying
 * up to `MAX_MATCH_ATTEMPTS` times if (and only if) the response fails
 * schema validation — see `MAX_MATCH_ATTEMPTS`'s docstring. Throws
 * `ClaudeApiError` unchanged (no retry) or, after the final attempt still
 * fails validation, the last `ClaudeResponseValidationError` — callers
 * catch both and map to `502`, same as before this existed.
 */
async function getValidatedMatchAssessment(
  resumeText: string,
  jobDescriptionText: string,
): Promise<{ message: Anthropic.Message; result: MatchResult }> {
  let lastValidationError: ClaudeResponseValidationError | undefined;

  for (let attempt = 1; attempt <= MAX_MATCH_ATTEMPTS; attempt++) {
    const message = await matchResumeToJob(resumeText, jobDescriptionText);

    try {
      return { message, result: parseMatchResponse(message) };
    } catch (err) {
      if (!(err instanceof ClaudeResponseValidationError)) {
        throw err;
      }

      lastValidationError = err;
      console.error(
        `POST /api/matches: Claude response failed schema validation on attempt ${attempt}/${MAX_MATCH_ATTEMPTS}${
          attempt < MAX_MATCH_ATTEMPTS ? ", retrying" : ", giving up"
        }:`,
        err.message,
      );
    }
  }

  // Unreachable in practice — the loop only exits via `return` (success) or
  // the final iteration's `throw` above is never hit for
  // ClaudeResponseValidationError (it falls through to here instead once
  // attempts are exhausted). Thrown explicitly so this function's return
  // type stays non-nullable for callers rather than requiring a
  // non-null assertion at the call site.
  throw (
    lastValidationError ??
    new ClaudeResponseValidationError(
      "Claude match assessment failed validation and no error was captured.",
    )
  );
}

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
    const { message, result } = await getValidatedMatchAssessment(
      resume.extracted_text,
      jobDescription.description,
    );

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
