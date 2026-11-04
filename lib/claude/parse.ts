/**
 * v1 output contracts and their semantic validation, per docs/ARCHITECTURE.md
 * §13.5.2 ("parse.ts is reduced to semantic validation") and §13.5.6.
 * Deleted with the v1 routes in M3.9.
 *
 * Since M1.1, structured outputs (`output_config.format`, sent by
 * `callStructured()`) guarantee the JSON shape, and `callStructured()`
 * rejects anything that doesn't match these zod schemas. The forced-tool
 * extraction (`extractToolUseInput`), `repairListField`,
 * `repairMatchResponseShape`, `TAG_COVERAGE_THRESHOLD`, and
 * `ClaudeResponseValidationError` are gone. What's left here is:
 *
 *   1. The zod schemas. They describe structure only (types and required
 *      keys), and are what `zodOutputFormat` turns into the wire JSON Schema.
 *      Field order and names are the v1 contract the UI and the
 *      `resume_analyses` / `matches` columns depend on. Do not rename.
 *   2. `validateResumeAnalysis` / `validateMatchResult`: meaning checks the
 *      schema can't express (or that the SDK strips from the wire schema):
 *      score is an integer 0..100, required strings non-empty, list entries
 *      non-empty. Out-of-contract scalars are rejected
 *      (`ClaudeInvalidOutputError`), never clamped. Empty list entries are
 *      dropped and counted.
 *
 * The exported types are imported by lib/supabase/queries/{analyses,matches}.ts.
 */

import { z } from "zod";

import {
  assertIntInRange,
  assertNonEmptyString,
  cleanStringList,
} from "@/lib/claude/semanticValidation";

// ---------------------------------------------------------------------------
// Resume analysis (POST /api/resumes/:id/analyze)
// ---------------------------------------------------------------------------

const strengthWeaknessItemSchema = z.object({
  label: z
    .string()
    .describe("Short label for this strength or weakness, e.g. 'Strong backend experience'."),
  detail: z
    .string()
    .describe("One to two sentences of specific detail from the resume that supports the label."),
});

/** Mirrors the `resume_analyses` columns (docs/ARCHITECTURE.md §1). */
export const resumeAnalysisResultSchema = z.object({
  strengths: z.array(strengthWeaknessItemSchema).describe("Notable strengths found in the resume."),
  weaknesses: z
    .array(strengthWeaknessItemSchema)
    .describe("Notable weaknesses or gaps found in the resume."),
  summary: z.string().describe("A short (2-4 sentence) overview of the candidate."),
  suggested_roles: z
    .array(z.string())
    .describe("Realistic job titles this candidate appears well suited for."),
});

export type ResumeAnalysisResult = z.infer<typeof resumeAnalysisResultSchema>;

export type Validated<T> = { value: T; dropped: number };

function cleanItems(items: ResumeAnalysisResult["strengths"]): {
  kept: ResumeAnalysisResult["strengths"];
  dropped: number;
} {
  const kept = items
    .map((item) => ({ label: item.label.trim(), detail: item.detail.trim() }))
    .filter((item) => item.label.length > 0 && item.detail.length > 0);
  return { kept, dropped: items.length - kept.length };
}

/**
 * Semantic checks for a schema-valid analysis:
 * - `summary` must be non-empty -> otherwise invalid;
 * - strength/weakness items with an empty label or detail -> dropped;
 * - empty `suggested_roles` entries -> dropped.
 * Empty lists are allowed (as in v1).
 */
export function validateResumeAnalysis(
  output: ResumeAnalysisResult,
): Validated<ResumeAnalysisResult> {
  const summary = assertNonEmptyString(output.summary, "summary");
  const strengths = cleanItems(output.strengths);
  const weaknesses = cleanItems(output.weaknesses);
  const roles = cleanStringList(output.suggested_roles);

  return {
    value: {
      strengths: strengths.kept,
      weaknesses: weaknesses.kept,
      summary,
      suggested_roles: roles.kept,
    },
    dropped: strengths.dropped + weaknesses.dropped + roles.dropped,
  };
}

// ---------------------------------------------------------------------------
// Match assessment (POST /api/matches)
// ---------------------------------------------------------------------------

/** Mirrors the `matches` columns (docs/ARCHITECTURE.md §1). */
export const matchResultSchema = z.object({
  score: z
    .number()
    .int()
    .describe("Overall fit as an integer from 0 (no meaningful alignment) to 100 (excellent alignment)."),
  rationale: z.string().describe("A short (2-4 sentence) explanation of the score, specific to this resume and job."),
  matched_strengths: z
    .array(z.string())
    .describe("One short plain-text point per resume strength that is relevant to this job. Empty array if none."),
  gaps: z
    .array(z.string())
    .describe("One short plain-text point per area where the resume falls short of the job. Empty array if none."),
});

export type MatchResult = z.infer<typeof matchResultSchema>;

/**
 * Semantic checks for a schema-valid match:
 * - `score` must be an integer 0..100 (the `matches.score` check constraint)
 *   -> otherwise invalid. Never clamped;
 * - `rationale` must be non-empty -> otherwise invalid;
 * - empty `matched_strengths` / `gaps` entries -> dropped.
 */
export function validateMatchResult(output: MatchResult): Validated<MatchResult> {
  const score = assertIntInRange(output.score, 0, 100, "score");
  const rationale = assertNonEmptyString(output.rationale, "rationale");
  const strengths = cleanStringList(output.matched_strengths);
  const gaps = cleanStringList(output.gaps);

  return {
    value: { score, rationale, matched_strengths: strengths.kept, gaps: gaps.kept },
    dropped: strengths.dropped + gaps.dropped,
  };
}
