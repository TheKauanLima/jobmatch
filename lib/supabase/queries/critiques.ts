/**
 * Postgres access for `resume_critiques` (migration 0010,
 * docs/ARCHITECTURE.md §13.3.8, §13.20.2, §13.20.5).
 *
 * Two kinds of client, per §13.20.1 decision 9:
 * - Reads (`getLatestCritique`, `getStandaloneCritique`) take the caller's
 *   RLS-scoped **session** client (`lib/supabase/server.ts`). The
 *   `resume_critiques_select_own` policy limits them to the caller's rows.
 * - Writes (`insertResumeCritique`, `refundCritiqueCharge`) take the
 *   **service-role** client: users have no insert policy (so nobody can
 *   forge a critique row through PostgREST) and no update privilege on
 *   `rate_limit_events`. These two functions are inside the §13.14
 *   service-role boundary; their only caller is `lib/critique/service.ts`,
 *   which passes a `userId` taken from the verified session, never from
 *   request input. Each admin query filters on that `userId` (§13.15 item 3),
 *   and a same-owner trigger re-checks the insert in the database.
 *
 * Error messages carry the operation plus PostgREST's code/message only,
 * never critique or resume content.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { CritiqueResumeValue } from "@/lib/claude/tasks/critiqueResume";
import type { Database, Json } from "@/types/database";
import type { ResumeCritiqueRow } from "@/types/domain";

type SessionClient = SupabaseClient<Database>;
type AdminClient = SupabaseClient<Database>;

/** The partial unique index that caches one standalone critique per (resume, prompt version). */
export const STANDALONE_CRITIQUE_KEY = "resume_critiques_standalone_key";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export class CritiqueQueryError extends Error {
  readonly code: string | null;
  /** True when the insert lost the race on `resume_critiques_standalone_key`. */
  readonly isStandaloneConflict: boolean;

  constructor(
    operation: string,
    error: { code?: string | null; message?: string | null; details?: string | null },
  ) {
    const code = error.code ?? null;
    const detail = (error.message ?? "unknown error").slice(0, 300);
    super(`${operation} failed${code ? ` (${code})` : ""}: ${detail}`);
    this.name = "CritiqueQueryError";
    this.code = code;
    this.isStandaloneConflict =
      code === POSTGRES_UNIQUE_VIOLATION &&
      `${error.message ?? ""} ${error.details ?? ""}`.includes(STANDALONE_CRITIQUE_KEY);
  }
}

// ---------------------------------------------------------------------------
// Reads (session client, RLS)
// ---------------------------------------------------------------------------

/**
 * The newest critique for a resume, any prompt version and any origin
 * (standalone or, from M3, a report's), or `null`. Callers check resume
 * ownership first so "not yours" (404 not_found) and "none yet"
 * (404 no_critique) stay distinct.
 */
export async function getLatestCritique(
  session: SessionClient,
  resumeId: string,
): Promise<ResumeCritiqueRow | null> {
  const { data, error } = await session
    .from("resume_critiques")
    .select("*")
    .eq("resume_id", resumeId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new CritiqueQueryError("get_latest_critique", error);
  return data;
}

/**
 * The cached standalone (V1) critique for `(resumeId, promptVersion)`, or
 * `null`. At most one exists (`resume_critiques_standalone_key`).
 */
export async function getStandaloneCritique(
  session: SessionClient,
  resumeId: string,
  promptVersion: string,
): Promise<ResumeCritiqueRow | null> {
  const { data, error } = await session
    .from("resume_critiques")
    .select("*")
    .eq("resume_id", resumeId)
    .eq("prompt_version", promptVersion)
    .is("report_id", null)
    .maybeSingle();

  if (error) throw new CritiqueQueryError("get_standalone_critique", error);
  return data;
}

/** The columns the dashboard needs per critique: score, date and the dimensions (for the top priority). */
export type CritiqueSummaryRow = Pick<
  ResumeCritiqueRow,
  "id" | "resume_id" | "overall_score" | "dimension_scores" | "prompt_version" | "created_at"
>;

/**
 * The newest critique summary for each of `resumeIds` (any prompt version,
 * any origin), for the dashboard's resume list: one query instead of one
 * `getLatestCritique` per resume. Resumes without a critique are simply
 * absent from the result. Returns rows newest first, at most one per resume.
 *
 * Session client: RLS (`resume_critiques_select_own`) is the guarantee, and
 * the explicit `user_id` filter (the session user, never request input)
 * keeps the read owner-scoped even if called with an unexpected id. Selects
 * only the summary columns, never summary/line-feedback text.
 */
export async function listLatestCritiqueSummaries(
  session: SessionClient,
  userId: string,
  resumeIds: readonly string[],
): Promise<CritiqueSummaryRow[]> {
  if (resumeIds.length === 0) return [];

  const { data, error } = await session
    .from("resume_critiques")
    .select("id, resume_id, overall_score, dimension_scores, prompt_version, created_at")
    .eq("user_id", userId)
    .in("resume_id", [...resumeIds])
    .order("created_at", { ascending: false });

  if (error) throw new CritiqueQueryError("list_latest_critique_summaries", error);

  const latest = new Map<string, CritiqueSummaryRow>();
  for (const row of data ?? []) {
    if (!latest.has(row.resume_id)) latest.set(row.resume_id, row);
  }
  return [...latest.values()];
}

// ---------------------------------------------------------------------------
// Writes (service-role client)
// ---------------------------------------------------------------------------

/**
 * Inserts a standalone critique with the id returned by
 * `request_resume_critique` (so the rate-limit ledger's `ref_id` points at
 * it). `userId` must be the session user. Throws `CritiqueQueryError`;
 * `isStandaloneConflict` is set when a concurrent request already stored
 * the critique for this `(resume, prompt version)`.
 */
export async function insertResumeCritique(
  admin: AdminClient,
  params: {
    id: string;
    userId: string;
    resumeId: string;
    promptVersion: string;
    model: string;
    value: CritiqueResumeValue;
    droppedItems: number;
  },
): Promise<ResumeCritiqueRow> {
  const { value } = params;
  const { data, error } = await admin
    .from("resume_critiques")
    .insert({
      id: params.id,
      user_id: params.userId,
      resume_id: params.resumeId,
      report_id: null,
      profile_id: null,
      prompt_version: params.promptVersion,
      model: params.model,
      overall_score: value.overall_score,
      summary: value.summary,
      student_context: value.student_context as unknown as Json,
      dimension_scores: value.dimensions as unknown as Json,
      line_feedback: value.line_feedback as unknown as Json,
      section_feedback: value.section_feedback as unknown as Json,
      ats_issues: value.ats_issues as unknown as Json,
      missing_sections: value.missing_sections as unknown as Json,
      dropped_items: params.droppedItems,
    })
    .select("*")
    .single();

  if (error) throw new CritiqueQueryError("insert_resume_critique", error);
  if (!data) throw new CritiqueQueryError("insert_resume_critique", { message: "no row returned" });
  return data;
}

/**
 * Refunds the `resume_report` charge made for `critiqueId`
 * (`rate_limit_events.refunded_at`, matched by `ref_id` and the session
 * user, §13.10.4 convention). Idempotent: an already refunded row is left
 * alone. Returns how many rows were refunded (0 or 1).
 */
export async function refundCritiqueCharge(
  admin: AdminClient,
  userId: string,
  critiqueId: string,
  now: Date = new Date(),
): Promise<number> {
  const { data, error } = await admin
    .from("rate_limit_events")
    .update({ refunded_at: now.toISOString() })
    .eq("ref_id", critiqueId)
    .eq("user_id", userId)
    .eq("kind", "resume_report")
    .is("refunded_at", null)
    .select("id");

  if (error) throw new CritiqueQueryError("refund_critique_charge", error);
  return data?.length ?? 0;
}
