/**
 * Postgres access for the `resume_analyses` table, per
 * docs/ARCHITECTURE.md §3. Same conventions as
 * `lib/supabase/queries/resumes.ts`: every function takes the RLS-scoped
 * server client (never `lib/supabase/admin.ts`) and additionally filters by
 * `user_id` explicitly, so a "no row" result collapses cleanly into a `404`
 * at the route handler instead of relying solely on RLS silently returning
 * nothing.
 *
 * `resume_analyses` is a history table (docs/ARCHITECTURE.md §1) — there is
 * no update/delete here, only inserts and "get the latest" reads.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";
import type { ResumeAnalysisResult } from "@/lib/claude/parse";

type Client = SupabaseClient<Database>;
export type ResumeAnalysisRow =
  Database["public"]["Tables"]["resume_analyses"]["Row"];

/** Thrown when a Postgres operation on `resume_analyses` fails unexpectedly. */
export class AnalysisQueryError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AnalysisQueryError";
  }
}

/**
 * Fetches the most recent analysis for a resume, scoped to its owner.
 * Returns `null` if none exists yet or the resume isn't owned by `userId` —
 * callers turn that into a `404` (never a `403`), per
 * docs/ARCHITECTURE.md §2.
 */
export async function getLatestAnalysis(
  supabase: Client,
  userId: string,
  resumeId: string,
): Promise<ResumeAnalysisRow | null> {
  const { data, error } = await supabase
    .from("resume_analyses")
    .select("*")
    .eq("resume_id", resumeId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new AnalysisQueryError(
      `Failed to fetch latest analysis for resume ${resumeId}: ${error.message}`,
      error,
    );
  }

  return data;
}

/**
 * Inserts a new `resume_analyses` row from a validated Claude response
 * (`lib/claude/parse.ts#parseResumeAnalysisResponse`). `resume_analyses` is
 * append-only history (docs/ARCHITECTURE.md §1) — re-analysis always
 * inserts a new row rather than mutating a prior one.
 */
export async function createAnalysis(
  supabase: Client,
  params: {
    resumeId: string;
    userId: string;
    model: string;
    result: ResumeAnalysisResult;
  },
): Promise<ResumeAnalysisRow> {
  const { data, error } = await supabase
    .from("resume_analyses")
    .insert({
      resume_id: params.resumeId,
      user_id: params.userId,
      strengths: params.result.strengths,
      weaknesses: params.result.weaknesses,
      summary: params.result.summary,
      suggested_roles: params.result.suggested_roles,
      model: params.model,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new AnalysisQueryError(
      `Failed to create analysis for resume ${params.resumeId}: ${
        error?.message ?? "no row returned"
      }`,
      error,
    );
  }

  return data;
}
