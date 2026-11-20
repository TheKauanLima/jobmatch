import { NextResponse } from "next/server";

import "@/lib/tasks/registerUsageSink";
import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getResumeById, updateResume } from "@/lib/supabase/queries/resumes";
import { createAnalysis } from "@/lib/supabase/queries/analyses";
import {
  downloadResumeFile,
  extractResumeText,
  ResumeStorageError,
  ResumeTextExtractionError,
} from "@/lib/storage/resumeFiles";
import { DAILY_RATE_LIMITS, checkRateLimit } from "@/lib/claude/rateLimit";
import { analyzeResume } from "@/lib/claude/prompts/analyzeResume";
import { ClaudeApiError } from "@/lib/claude/errors";
import { SYNC_ROUTE_CLAUDE_DEADLINE_MS } from "@/lib/claude/config";
import { toResumeAnalysis } from "@/types/domain";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Must exceed `SYNC_ROUTE_CLAUDE_DEADLINE_MS` (270 s), so the deadline
 * always fires first and the catch below still runs: the resume is marked
 * 'failed' and the client gets a JSON 502, never a platform 504 with the
 * resume stuck on 'processing'. Matches app/api/worker/tick/route.ts.
 */
export const maxDuration = 300;

/**
 * POST /api/resumes/:id/analyze — run Claude strengths/weaknesses
 * extraction for a resume, per docs/ARCHITECTURE.md §2.
 *
 * Flow: auth -> ownership check (404) -> daily rate-limit check (429) ->
 * resolve `extracted_text` (extracting from the stored file first if this
 * is the first analysis, 422 on failure) -> mark `resumes.status =
 * 'processing'` -> call Claude (structured output + semantic validation,
 * with one retry on invalid output, all inside `analyzeResume`) -> insert a
 * `resume_analyses` row -> mark `resumes.status = 'analyzed'`. Any failure
 * from the Claude call onward is caught and always resolves the resume's
 * status to `'failed'` (never left stuck on `'processing'`), then returns
 * `502`.
 *
 * Never logs resume text or Claude response content — only error messages,
 * per the no-PII-in-logs rule (see CLAUDE.md).
 */
export async function POST(_request: Request, { params }: RouteContext) {
  // Started first, so time spent on auth/extraction counts against it too
  // (see `maxDuration` above). Bounds the whole Claude step, retries included.
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

  const { id } = await params;
  const supabase = await createClient();

  let resume;
  try {
    resume = await getResumeById(supabase, user.id, id);
  } catch (err) {
    console.error(
      "POST /api/resumes/:id/analyze: failed to fetch resume:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to analyze resume." },
      { status: 500 },
    );
  }

  if (!resume) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  try {
    const rateLimitResult = await checkRateLimit(supabase, user.id, {
      kind: "analyze",
      limit: DAILY_RATE_LIMITS.analyze,
    });

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        {
          error: "Daily analysis limit reached. Try again tomorrow.",
          retry_after: rateLimitResult.retryAfter,
        },
        { status: 429 },
      );
    }
  } catch (err) {
    console.error(
      "POST /api/resumes/:id/analyze: rate limit check failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to analyze resume." },
      { status: 500 },
    );
  }

  // Resolve the resume's text: use the stored `extracted_text` if present,
  // otherwise extract it from the stored file now (first analysis).
  let resumeText = resume.extracted_text;
  let newlyExtracted = false;

  if (!resumeText) {
    try {
      const buffer = await downloadResumeFile(supabase, resume.storage_path);
      resumeText = await extractResumeText(resume.file_type, buffer);
      newlyExtracted = true;
    } catch (err) {
      if (
        err instanceof ResumeTextExtractionError ||
        err instanceof ResumeStorageError
      ) {
        console.error(
          "POST /api/resumes/:id/analyze: text extraction failed:",
          err.message,
        );
        return NextResponse.json(
          { error: "Could not extract text from this resume file." },
          { status: 422 },
        );
      }
      throw err;
    }
  }

  if (!resumeText || resumeText.trim().length === 0) {
    return NextResponse.json(
      { error: "Could not extract text from this resume file." },
      { status: 422 },
    );
  }

  // Mark processing before the Claude call — and persist newly-extracted
  // text in the same update — so the resume is never left stuck on
  // 'uploaded' if the process dies before the try/catch below runs.
  try {
    await updateResume(supabase, user.id, id, {
      status: "processing",
      ...(newlyExtracted ? { extractedText: resumeText } : {}),
    });
  } catch (err) {
    console.error(
      "POST /api/resumes/:id/analyze: failed to mark resume processing:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to analyze resume." },
      { status: 500 },
    );
  }

  // Only the Claude call, response validation, and the resume_analyses
  // insert are covered here — a failure at any of these steps means no
  // analysis row exists yet, so 'failed' is the correct terminal status.
  // The subsequent 'analyzed' status flip is intentionally handled outside
  // this try/catch (see below): once `createAnalysis` succeeds, the
  // analysis genuinely exists and must not be reported as a failure just
  // because a later bookkeeping update has a hiccup.
  let analysis;
  try {
    const outcome = await analyzeResume(resumeText, {
      userId: user.id,
      signal: claudeDeadline,
    });

    analysis = await createAnalysis(supabase, {
      resumeId: id,
      userId: user.id,
      model: outcome.model,
      result: outcome.value,
    });
  } catch (err) {
    // Never leave the resume stuck on 'processing' — always resolve to
    // 'failed' before returning an error response.
    await updateResume(supabase, user.id, id, { status: "failed" }).catch(
      (statusErr) => {
        console.error(
          "POST /api/resumes/:id/analyze: failed to mark resume failed after an error:",
          statusErr instanceof Error ? statusErr.message : "unknown error",
        );
      },
    );

    // Every Claude-layer failure (unavailable, refused, truncated, invalid
    // output, bad request) is a ClaudeApiError subclass.
    if (err instanceof ClaudeApiError) {
      // `code` and `message` are PII-free by construction (lib/claude/errors.ts).
      console.error(
        "POST /api/resumes/:id/analyze: Claude analysis failed:",
        err.code,
        err.message,
      );
      return NextResponse.json(
        { error: "Resume analysis failed. Please try again." },
        { status: 502 },
      );
    }

    console.error(
      "POST /api/resumes/:id/analyze: unexpected failure:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to analyze resume." },
      { status: 500 },
    );
  }

  // The resume_analyses row is confirmed created at this point. Flipping
  // resumes.status to 'analyzed' is best-effort bookkeeping — if it fails,
  // the analysis itself is still valid and retrievable via
  // GET /api/resumes/:id/analysis, so this must not turn a successful
  // analysis into a reported 502/500 (see BUG 2 fix).
  await updateResume(supabase, user.id, id, { status: "analyzed" }).catch(
    (statusErr) => {
      console.error(
        "POST /api/resumes/:id/analyze: analysis succeeded but failed to update resume status to 'analyzed':",
        statusErr instanceof Error ? statusErr.message : "unknown error",
      );
    },
  );

  return NextResponse.json(
    { analysis: toResumeAnalysis(analysis) },
    { status: 201 },
  );
}
