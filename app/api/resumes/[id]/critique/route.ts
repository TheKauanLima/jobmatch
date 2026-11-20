import { NextResponse } from "next/server";

import "@/lib/tasks/registerUsageSink";
import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { CLAUDE_TASKS, SYNC_ROUTE_CLAUDE_DEADLINE_MS } from "@/lib/claude/config";
import type { ClaudeErrorCode } from "@/lib/claude/errors";
import { requestCritique, type CritiqueRequestResult } from "@/lib/critique/service";
import { getLatestCritique } from "@/lib/supabase/queries/critiques";
import { getResumeById } from "@/lib/supabase/queries/resumes";
import { createClient } from "@/lib/supabase/server";
import { toCritique } from "@/types/domain";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Must exceed `SYNC_ROUTE_CLAUDE_DEADLINE_MS` (270 s), so the deadline
 * always fires first and the service still refunds and answers with a JSON
 * 502 instead of a platform 504 (§13.13.1, §13.20.1 decision 1).
 */
export const maxDuration = 300;

/** Private per-user data: never cached by browsers or proxies. */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// User-facing copy by code (§13.13.9; the frontend may polish wording).
const COPY = {
  not_found: "Not found.",
  no_critique: "This resume has no critique yet.",
  text_extraction_failed:
    "We couldn't read text from this file. Try a PDF exported from your editor, or a DOCX.",
  budget_exhausted:
    "Kalify's AI features have reached today's capacity. Try again after 00:00 UTC.",
  rate_limited: "You've used all of today's resume reports. Try again after 00:00 UTC.",
  /** Only when the charge was actually refunded. */
  systemRefunded:
    "Something went wrong on our side. Retry, and this one won't count toward your daily limit.",
  /** System failure without a (successful) refund: no promise about the limit. */
  system: "Something went wrong on our side. Please try again.",
  model: "We couldn't finish this section. Retry.",
} as const;

const AI_ERROR_COPY: Record<ClaudeErrorCode, string> = {
  ai_unavailable: COPY.system,
  ai_bad_request: COPY.model,
  ai_refused: COPY.model,
  ai_invalid_output: COPY.model,
  ai_truncated: COPY.model,
};

/** Says "won't count" only when the refund really happened (§13.13.9 copy is conditional on it). */
function systemCopy(refunded: boolean): string {
  return refunded ? COPY.systemRefunded : COPY.system;
}

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function unauthorized(err: UnauthorizedError) {
  return json({ error: err.message }, err.status);
}

/** Maps the service's discriminated result to the §13.20.4 HTTP contract. */
function toResponse(result: CritiqueRequestResult) {
  switch (result.kind) {
    case "ok":
      return json({ critique: result.critique }, result.status);
    case "not_found":
      return json({ error: COPY.not_found, code: "not_found" }, 404);
    case "text_extraction_failed":
      return json({ error: COPY.text_extraction_failed, code: "text_extraction_failed" }, 422);
    case "budget_exhausted":
      return json(
        { error: COPY.budget_exhausted, code: "budget_exhausted", retry_after: result.retryAfter },
        503,
      );
    case "rate_limited":
      return json(
        {
          error: COPY.rate_limited,
          code: "rate_limited",
          kind: "resume_report",
          retry_after: result.retryAfter,
        },
        429,
      );
    case "ai_error":
      return json(
        {
          error: result.code === "ai_unavailable" ? systemCopy(result.refunded) : AI_ERROR_COPY[result.code],
          code: result.code,
        },
        502,
      );
    case "internal_error":
      return json({ error: systemCopy(result.refunded), code: "internal_error" }, 500);
  }
}

/**
 * GET /api/resumes/:id/critique — the latest critique for one of the
 * caller's resumes (any prompt version), read through the session client
 * (RLS). Never calls Claude. §13.20.4.
 *
 * 200 { critique } | 401 | 404 not_found (resume not the caller's) |
 * 404 no_critique | 500 internal_error.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  let user;
  try {
    ({ user } = await requireSession());
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err);
    throw err;
  }

  const { id } = await params;
  try {
    const supabase = await createClient();
    const resume = await getResumeById(supabase, user.id, id);
    if (!resume) {
      return json({ error: COPY.not_found, code: "not_found" }, 404);
    }
    const row = await getLatestCritique(supabase, id);
    if (!row) {
      return json({ error: COPY.no_critique, code: "no_critique" }, 404);
    }
    return json({ critique: toCritique(row, CLAUDE_TASKS.critiqueResume.promptVersion) }, 200);
  } catch (err) {
    console.error(
      `[critique] ${JSON.stringify({ stage: "get", resume_id: id, error: err instanceof Error ? err.name : "unknown error" })}`,
    );
    return json({ error: COPY.system, code: "internal_error" }, 500);
  }
}

/**
 * POST /api/resumes/:id/critique (no body) — run, charge and cache the V1
 * critique (§13.20.4). A stored critique for the current prompt version is
 * returned with 200 at no charge; a new one is returned with 201. All the
 * steps after authentication live in `lib/critique/service.ts`.
 *
 * Calls Claude inline under the §13.13.1 sync-route exception (until M3.9),
 * so it imports `registerUsageSink` to record spend.
 */
export async function POST(_request: Request, { params }: RouteContext) {
  // Step 1: started first, so auth and text extraction count against it too.
  const claudeDeadline = AbortSignal.timeout(SYNC_ROUTE_CLAUDE_DEADLINE_MS);

  let user;
  try {
    ({ user } = await requireSession());
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err);
    throw err;
  }

  const { id } = await params;
  try {
    const supabase = await createClient();
    return toResponse(await requestCritique(supabase, user, id, claudeDeadline));
  } catch (err) {
    // requestCritique returns results rather than throwing; this is a
    // last-resort guard (e.g. the client factory failing).
    console.error(
      `[critique] ${JSON.stringify({ stage: "post", resume_id: id, error: err instanceof Error ? err.name : "unknown error" })}`,
    );
    return json({ error: COPY.system, code: "internal_error" }, 500);
  }
}
