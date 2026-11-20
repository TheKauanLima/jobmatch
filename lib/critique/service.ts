/**
 * V1 resume critique orchestration: `POST /api/resumes/:id/critique`
 * (docs/ARCHITECTURE.md §13.20.4, §13.20.5). Retired by M3.9, when the POST
 * route is deleted and reports produce critiques instead.
 *
 * `requestCritique` runs everything after authentication and returns a
 * discriminated result that the route maps to HTTP. In order:
 *   2. load the resume with the session client (RLS)        -> not_found
 *   3. cached standalone critique for the current prompt   -> ok (200), free
 *   4. resume text: stored, or downloaded + extracted and persisted
 *      (BEFORE any charge; never touches resumes.status)  -> text_extraction_failed
 *   5. global AI budget (§13.9.4; query error fails closed)  -> budget_exhausted
 *   6. atomic charge: rpc request_resume_critique           -> rate_limited / not_found
 *   7. Claude (`runCritiqueResume`, bounded by `signal`)
 *   8. insert through the service role with id = charge id; a concurrent
 *      winner on the cache key -> return its row, charge stands -> ok (200)
 *   9.                                                       -> ok (201)
 * (Step 1, the deadline signal and `requireSession`, is the route's.)
 *
 * Refunds after step 6 happen ONLY for system failures (`ai_unavailable`,
 * including the deadline, `ai_bad_request`, `internal_error`), mirroring
 * §13.10.4. Model-side outcomes a user can provoke (`ai_refused`,
 * `ai_invalid_output`, `ai_truncated`) are not refunded. A failed refund is
 * logged (ids only) and never thrown.
 *
 * A race loser (a parallel POST for the same resume whose insert hits the
 * cache key) is NOT refunded: its Claude call was billed, so the charge
 * stands and billed calls never exceed charged units. It still gets the
 * winner's critique (200). The frontend blocks double-submit, so normal use
 * never gets here.
 *
 * Service-role use (§13.14 boundary): this module creates the admin client
 * for the budget query, the critique insert and the refund. Every admin
 * query on user data is filtered by `user.id` from the verified session.
 *
 * Never logs resume text or critique content: ids and machine codes only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { CLAUDE_TASKS } from "@/lib/claude/config";
import { ClaudeApiError, type ClaudeErrorCode } from "@/lib/claude/errors";
import { runCritiqueResume } from "@/lib/claude/tasks/critiqueResume";
import { nextUtcMidnight } from "@/lib/rateLimit";
import {
  downloadResumeFile,
  extractResumeText,
  ResumeStorageError,
  ResumeTextExtractionError,
} from "@/lib/storage/resumeFiles";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getStandaloneCritique,
  insertResumeCritique,
  refundCritiqueCharge,
  CritiqueQueryError,
} from "@/lib/supabase/queries/critiques";
import { getResumeById, updateResume } from "@/lib/supabase/queries/resumes";
import { getAiSpendSince } from "@/lib/supabase/queries/usage";
import { checkGlobalAiBudget } from "@/lib/tasks/budget";
import type { Database } from "@/types/database";
import { toCritique, type Critique } from "@/types/domain";

type SessionClient = SupabaseClient<Database>;

/** Claude codes that count as system failures and are refunded (§13.20.4). */
const REFUNDED_AI_CODES: ReadonlySet<ClaudeErrorCode> = new Set<ClaudeErrorCode>([
  "ai_unavailable",
  "ai_bad_request",
]);

export type CritiqueRequestResult =
  | { kind: "ok"; status: 200 | 201; critique: Critique }
  | { kind: "not_found" }
  | { kind: "text_extraction_failed" }
  | { kind: "budget_exhausted"; retryAfter: string }
  | { kind: "rate_limited"; retryAfter: string }
  | { kind: "ai_error"; code: ClaudeErrorCode; refunded: boolean }
  | { kind: "internal_error"; refunded: boolean };

function logFailure(stage: string, err: unknown, ids: Record<string, string> = {}): void {
  // `message` of our own error classes is PII-free by construction (codes,
  // PostgREST messages, ids). Unknown errors are reduced to their name.
  const detail =
    err instanceof ClaudeApiError || err instanceof CritiqueQueryError
      ? err.message
      : err instanceof Error
        ? err.name
        : "unknown error";
  console.error(`[critique] ${JSON.stringify({ stage, ...ids, error: detail })}`);
}

function currentPromptVersion(): string {
  return CLAUDE_TASKS.critiqueResume.promptVersion;
}

/**
 * Steps 2-9 of `POST /api/resumes/:id/critique` (see the module docstring).
 *
 * @param session the caller's cookie-bound, RLS-scoped client
 * @param user    the verified session user (`requireSession`)
 * @param signal  the route's overall Claude deadline (270 s)
 */
export async function requestCritique(
  session: SessionClient,
  user: { id: string },
  resumeId: string,
  signal: AbortSignal,
): Promise<CritiqueRequestResult> {
  const promptVersion = currentPromptVersion();

  // ---- 2. resume (session client) ----
  let resume;
  try {
    resume = await getResumeById(session, user.id, resumeId);
  } catch (err) {
    logFailure("load_resume", err, { resume_id: resumeId });
    return { kind: "internal_error", refunded: false };
  }
  if (!resume) {
    return { kind: "not_found" };
  }

  // ---- 3. cache: no charge, no Claude call ----
  try {
    const cached = await getStandaloneCritique(session, resumeId, promptVersion);
    if (cached) {
      return { kind: "ok", status: 200, critique: toCritique(cached, promptVersion) };
    }
  } catch (err) {
    logFailure("cache_lookup", err, { resume_id: resumeId });
    return { kind: "internal_error", refunded: false };
  }

  // ---- 4. text, before any charge ----
  let resumeText = resume.extracted_text;
  if (!resumeText) {
    try {
      const buffer = await downloadResumeFile(session, resume.storage_path);
      resumeText = await extractResumeText(resume.file_type, buffer);
    } catch (err) {
      if (err instanceof ResumeTextExtractionError || err instanceof ResumeStorageError) {
        logFailure("extract_text", err, { resume_id: resumeId });
        return { kind: "text_extraction_failed" };
      }
      logFailure("extract_text", err, { resume_id: resumeId });
      return { kind: "internal_error", refunded: false };
    }
    if (!resumeText || resumeText.trim().length === 0) {
      return { kind: "text_extraction_failed" };
    }
    try {
      // Persisted so every stored quote is a slice of resumes.extracted_text.
      // Only extracted_text is written; resumes.status belongs to the
      // analysis/report flows.
      await updateResume(session, user.id, resumeId, { extractedText: resumeText });
    } catch (err) {
      logFailure("persist_text", err, { resume_id: resumeId });
      return { kind: "internal_error", refunded: false };
    }
  }
  if (resumeText.trim().length === 0) {
    return { kind: "text_extraction_failed" };
  }

  // ---- 5. global budget (fail closed) ----
  let admin: ReturnType<typeof createAdminClient>;
  const now = new Date();
  try {
    admin = createAdminClient();
    const budget = await checkGlobalAiBudget(async (since) => {
      const rows = await getAiSpendSince(admin, since, { signal });
      return rows.reduce((sum, row) => sum + row.costUsd, 0);
    }, now);
    if (budget.exhausted) {
      console.warn(
        `[critique] ${JSON.stringify({ stage: "budget", spent_usd: budget.spentUsd, budget_usd: budget.budgetUsd })}`,
      );
      return { kind: "budget_exhausted", retryAfter: nextUtcMidnight(now) };
    }
  } catch (err) {
    logFailure("budget", err);
    return { kind: "internal_error", refunded: false };
  }

  // ---- 6. atomic charge ----
  const { data: critiqueId, error: chargeError } = await session.rpc("request_resume_critique", {
    p_resume_id: resumeId,
  });
  if (chargeError) {
    if (chargeError.message === "rate_limited:resume_report") {
      return { kind: "rate_limited", retryAfter: nextUtcMidnight(now) };
    }
    if (chargeError.message === "not_found") {
      return { kind: "not_found" };
    }
    console.error(
      `[critique] ${JSON.stringify({ stage: "charge", code: chargeError.code ?? null, error: (chargeError.message ?? "").slice(0, 200) })}`,
    );
    return { kind: "internal_error", refunded: false };
  }
  if (typeof critiqueId !== "string" || critiqueId.length === 0) {
    console.error(`[critique] ${JSON.stringify({ stage: "charge", error: "no id returned" })}`);
    return { kind: "internal_error", refunded: false };
  }

  const refund = async (): Promise<boolean> => {
    try {
      return (await refundCritiqueCharge(admin, user.id, critiqueId)) > 0;
    } catch (err) {
      logFailure("refund", err, { critique_id: critiqueId });
      return false;
    }
  };

  // ---- 7. Claude ----
  let outcome;
  try {
    outcome = await runCritiqueResume(
      { resumeText, sourceText: resumeText },
      { userId: user.id, signal },
    );
  } catch (err) {
    logFailure("claude", err, { critique_id: critiqueId });
    if (err instanceof ClaudeApiError) {
      const refunded = REFUNDED_AI_CODES.has(err.code) ? await refund() : false;
      return { kind: "ai_error", code: err.code, refunded };
    }
    return { kind: "internal_error", refunded: await refund() };
  }

  // ---- 8. insert (service role) ----
  try {
    const row = await insertResumeCritique(admin, {
      id: critiqueId,
      userId: user.id,
      resumeId,
      promptVersion,
      model: outcome.model,
      value: outcome.value,
      droppedItems: outcome.dropped,
    });
    // ---- 9. ----
    return { kind: "ok", status: 201, critique: toCritique(row, promptVersion) };
  } catch (err) {
    if (err instanceof CritiqueQueryError && err.isStandaloneConflict) {
      // A concurrent POST stored the critique first. This request's Claude
      // call was billed, so its charge stands (no refund); return the winner.
      try {
        const existing = await getStandaloneCritique(session, resumeId, promptVersion);
        if (existing) {
          return { kind: "ok", status: 200, critique: toCritique(existing, promptVersion) };
        }
      } catch (readErr) {
        logFailure("race_read", readErr, { critique_id: critiqueId });
      }
      return { kind: "internal_error", refunded: false };
    }
    logFailure("insert", err, { critique_id: critiqueId });
    return { kind: "internal_error", refunded: await refund() };
  }
}
