/**
 * Shared zod-based validation of Claude's structured (tool-use) output, per
 * docs/ARCHITECTURE.md §3. This is the second half of the injection-
 * hardening story described in `lib/claude/prompts/analyzeResume.ts`: even
 * if a resume or job description manages to influence Claude's output, that
 * output still has to validate against the exact schema we expect
 * (`resume_analyses` / `matches` columns) or it's rejected outright —
 * nothing gets trusted or persisted just because Claude returned *something*
 * that looked like the right tool call.
 *
 * Route handlers catch `ClaudeResponseValidationError` and return `502`,
 * per docs/ARCHITECTURE.md §2 ("`502` if the Claude API call fails").
 */

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { ANALYZE_RESUME_TOOL_NAME } from "@/lib/claude/prompts/analyzeResume";
import { MATCH_RESUME_TO_JOB_TOOL_NAME } from "@/lib/claude/prompts/matchResumeToJob";

/**
 * Thrown when Claude's response either doesn't contain the expected
 * tool-use block, or the tool's `input` doesn't validate against the
 * expected schema. Route handlers turn this into a `502`.
 */
export class ClaudeResponseValidationError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ClaudeResponseValidationError";
  }
}

/**
 * Finds the first `tool_use` content block matching `toolName` in a Claude
 * `Message` and returns its (unvalidated) `input`. Throws
 * `ClaudeResponseValidationError` if no such block exists — e.g. Claude
 * refused, returned plain text instead, or (relevant to injection
 * hardening) was steered toward calling a different/no tool.
 */
export function extractToolUseInput(
  message: Anthropic.Message,
  toolName: string,
): unknown {
  const block = message.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === toolName,
  );

  if (!block) {
    throw new ClaudeResponseValidationError(
      `Claude response did not include a tool call to "${toolName}".`,
    );
  }

  return block.input;
}

/** Shape of one `strengths`/`weaknesses` entry, per docs/ARCHITECTURE.md §1. */
const strengthWeaknessItemSchema = z.object({
  label: z.string().min(1),
  detail: z.string().min(1),
});

/**
 * Expected shape of the `record_resume_analysis` tool's input, mirroring
 * the `resume_analyses` table columns (`strengths`, `weaknesses`,
 * `summary`, `suggested_roles`) in docs/ARCHITECTURE.md §1.
 */
export const resumeAnalysisResultSchema = z.object({
  strengths: z.array(strengthWeaknessItemSchema),
  weaknesses: z.array(strengthWeaknessItemSchema),
  summary: z.string().min(1),
  suggested_roles: z.array(z.string().min(1)),
});

export type ResumeAnalysisResult = z.infer<typeof resumeAnalysisResultSchema>;

/**
 * Extracts and validates the `record_resume_analysis` tool call from a
 * Claude response. Throws `ClaudeResponseValidationError` if the tool call
 * is missing or its input doesn't match `resumeAnalysisResultSchema` —
 * callers must not persist or trust the response otherwise.
 */
export function parseResumeAnalysisResponse(
  message: Anthropic.Message,
): ResumeAnalysisResult {
  const input = extractToolUseInput(message, ANALYZE_RESUME_TOOL_NAME);

  const result = resumeAnalysisResultSchema.safeParse(input);
  if (!result.success) {
    throw new ClaudeResponseValidationError(
      `Claude's resume analysis response failed schema validation: ${result.error.message}`,
      result.error,
    );
  }

  return result.data;
}

/**
 * Expected shape of the `record_match_assessment` tool's input, mirroring
 * the `matches` table columns (`score`, `rationale`, `matched_strengths`,
 * `gaps`) in docs/ARCHITECTURE.md §1. `score` is strictly validated as an
 * integer clamped to 0-100 (matching the `matches.score` Postgres check
 * constraint) — a response with an out-of-range or non-integer score is
 * rejected, not silently clamped, since silently "fixing" an
 * out-of-schema value is itself a way an injection attempt could sneak a
 * plausible-looking but untrusted value past validation.
 */
export const matchResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  rationale: z.string().min(1),
  matched_strengths: z.array(z.string().min(1)),
  gaps: z.array(z.string().min(1)),
});

export type MatchResult = z.infer<typeof matchResultSchema>;

/**
 * Best-effort repair for `matched_strengths`/`gaps` coming back as a
 * non-array STRING instead of a genuine JSON array of strings, even though
 * the tool's `input_schema` declares `type: "array"` and the prompt
 * explicitly requires it (see `lib/claude/prompts/matchResumeToJob.ts`).
 * This is a real, reproducible failure mode against the live Claude API —
 * NOT a single consistent shape, though. Live sampling (12 realistic
 * resume/job-description match calls, tracked in the M6 QA follow-up)
 * found at least three distinct malformed shapes in roughly even
 * proportion, none dominant enough to special-case alone:
 *
 *   1. An embedded, well-formed JSON array literal wrapped in what looks
 *      like a leaked, legacy text-based tool-call parameter tag, e.g.
 *      `"\n<parameter name=\"gaps\">[\"foo\", \"bar\"]\n"` — sometimes
 *      missing its closing `</parameter>` tag entirely. This looks like the
 *      model bleeding through an alternate/older XML-based tool-invocation
 *      format (`<parameter name="...">value</parameter>`) — notably NOT
 *      related to this app's own `<resume_text>`/`<job_description_text>`
 *      injection-hardening delimiters, which use different tag names
 *      entirely; ruled out as the cause of this leak.
 *   2. XML-style `<item>...</item>`-wrapped entries with no JSON inside,
 *      e.g. `"\n<item>foo</item>\n<item>bar</item>\n"`.
 *   3. A single plain-text sentence with no markup and no list structure at
 *      all — the model wrote one point as prose instead of a list.
 *
 * Given that variety, a single hardcoded tag-name repair (the original,
 * narrower version of this function only handled shape 2) does NOT
 * meaningfully move the measured failure rate — QA independently
 * reproduced shape 1 at a similar or higher rate. This version instead
 * layers general, decreasingly-precise strategies and stops at the first
 * one that produces a plausible result:
 *
 *   a. Look for an embedded `[...]` JSON array literal anywhere in the
 *      string and try to parse it (handles shape 1 losslessly — the
 *      content itself was never actually malformed, just wrapped).
 *   b. Look for ANY `<tag>...</tag>` pairs (any tag name, not just
 *      "item") and extract their inner text as list items — BUT only if
 *      those tag matches account for the vast majority of the string's
 *      length (see `TAG_COVERAGE_THRESHOLD` below). Handles shape 2 and
 *      equivalent variants under a different tag name.
 *   c. Strip any leftover stray tag-like markup, then split what's left on
 *      newlines/bullet markers if there's more than one line.
 *   d. If exactly one non-empty line/sentence remains, treat the whole
 *      thing as a single list item (handles shape 3) rather than
 *      discarding it.
 *
 * --- Coverage guard on strategy (b) (fixes a real bug QA found) ---
 * An earlier version of (b) fired on ANY well-formed `<tag>...</tag>` pair
 * anywhere in the string, with no check on how much of the string that tag
 * actually accounted for. QA found a deterministic false-positive: a
 * genuinely non-compliant string field that was legitimate prose mentioning
 * real markup mid-sentence — e.g. `"Wrote a codemod converting legacy
 * <table>Name</table> markup into the new DataTable component, removing
 * 15k lines..."` — got silently reduced to `["Name"]`, discarding the
 * entire sentence with no error and no log, since it still passed schema
 * validation cleanly as a well-formed (but wrong) array. The fix: strategy
 * (b) only fires when the matched tag(s) cover at least
 * `TAG_COVERAGE_THRESHOLD` of the trimmed string's length. Claude's actual
 * malformed wrapper tags (`<item>`/`<parameter>`) wrap the ENTIRE payload —
 * extracted content should account for nearly all of the string, with only
 * incidental whitespace outside the tag(s). A tag mentioned once mid-prose
 * leaves most of the string outside any match, which is the signal to skip
 * (b) and fall through to (c)/(d) instead — which, for the codemod example
 * above, correctly preserves the full sentence (with just the `<table>`/
 * `</table>` markup stripped) as a single list item, rather than discarding
 * everything but one word.
 *
 * Only triggers on a `string` value — a real array (however its individual
 * strings are worded, even if one happens to literally contain "<item>"
 * text) is returned completely untouched, and a non-string/missing field
 * is also left untouched so validation still rejects it normally. This is
 * still not a "coerce absolutely anything into an array" fallback: if none
 * of (a)-(d) produce a non-empty result, the original string is returned
 * unchanged and `matchResultSchema` rejects it exactly as before.
 *
 * Not a trust boundary change: every strategy only re-parses text Claude
 * itself already generated into a different container shape — it does not
 * grant Claude's output (or anything embedded in the resume/job
 * description that influenced it) any capability beyond what a compliant
 * array response would already have had, per the "schema validation is
 * structural only, not semantic" limitation already documented on
 * `matchResultSchema`.
 */
/**
 * Minimum fraction (0-1) of the trimmed string's length that matched
 * `<tag>...</tag>` pairs must collectively account for before
 * `repairListField` strategy (b) treats them as Claude's own malformed
 * wrapper (rather than an incidental tag mention inside otherwise-legitimate
 * prose — see the coverage-guard note above). Genuine wrapper corruption
 * observed live covers ~95-100% of the string (only incidental whitespace
 * outside the tags); a mid-sentence tag mention typically covers well under
 * half. 0.8 is a deliberately conservative middle ground — high enough that
 * a single short tag in a long sentence cannot pass, low enough to tolerate
 * a little surrounding whitespace/newlines around genuine wrapper tags.
 */
const TAG_COVERAGE_THRESHOLD = 0.8;
function repairListField(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }

  // (a) Embedded JSON array literal (handles the "<parameter name=...">
  // leak, with or without a closing tag — the model sometimes truncates
  // it). Greedy match to the LAST "]" so a multi-line array with several
  // top-level string entries is captured whole, not just up to the first
  // "]" (which cannot appear inside a plain string entry in this schema
  // anyway, since these are flat arrays of strings, not nested arrays).
  const jsonArrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonArrayMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonArrayMatch[0]);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        const items = parsed.map((item) => item.trim()).filter((item) => item.length > 0);
        if (items.length > 0) {
          return items;
        }
      }
    } catch {
      // Not valid JSON after all — fall through to the next strategy.
    }
  }

  // (b) Any <tag>...</tag> pairs, regardless of tag name (generalizes past
  // hardcoding "item" specifically — the model's exact tag choice varies).
  // Gated by TAG_COVERAGE_THRESHOLD (see docstring above): only applied if
  // the matches collectively account for most of the string, so a tag
  // mentioned once inside otherwise-legitimate prose falls through to
  // (c)/(d) instead of silently discarding everything outside the tag.
  const tagMatches = [...trimmed.matchAll(/<([a-zA-Z][\w-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)];
  if (tagMatches.length > 0) {
    const coveredLength = tagMatches.reduce((sum, match) => sum + match[0].length, 0);
    const coverage = coveredLength / trimmed.length;

    if (coverage >= TAG_COVERAGE_THRESHOLD) {
      const items = tagMatches.map((match) => match[2].trim()).filter((item) => item.length > 0);
      if (items.length > 0) {
        return items;
      }
    }
  }

  // (c)/(d) Strip any remaining stray tag-like markup (e.g. an unclosed
  // "<parameter name=\"x\">" prefix with no embedded JSON array and no
  // matching close tag), then either split multiple lines/bullets into
  // separate items, or — if only one line of real content remains — treat
  // the whole thing as a single item rather than discarding it.
  const withoutTags = trimmed.replace(/<\/?[a-zA-Z][^>]*>/g, "").trim();
  const lines = withoutTags
    .split(/\r?\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0);

  if (lines.length > 0) {
    return lines;
  }

  return value;
}

/**
 * Applies `repairListField` to `matched_strengths`/`gaps` if the raw tool
 * input is a plain object, before schema validation runs. Leaves every
 * other field (including a non-object `input`) completely untouched.
 */
function repairMatchResponseShape(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }

  const record = input as Record<string, unknown>;
  return {
    ...record,
    matched_strengths: repairListField(record.matched_strengths),
    gaps: repairListField(record.gaps),
  };
}

/**
 * Extracts and validates the `record_match_assessment` tool call from a
 * Claude response. Applies `repairMatchResponseShape` first (see
 * `repairListField`'s docstring — a general, layered fixup covering several
 * observed non-compliant shapes, not one hardcoded pattern), then
 * validates. Throws `ClaudeResponseValidationError` if the tool call is
 * missing or its (possibly repaired) input still doesn't match
 * `matchResultSchema` — callers must not persist or trust the response
 * otherwise.
 */
export function parseMatchResponse(message: Anthropic.Message): MatchResult {
  const input = extractToolUseInput(message, MATCH_RESUME_TO_JOB_TOOL_NAME);
  const repaired = repairMatchResponseShape(input);

  const result = matchResultSchema.safeParse(repaired);
  if (!result.success) {
    throw new ClaudeResponseValidationError(
      `Claude's match assessment response failed schema validation: ${result.error.message}`,
      result.error,
    );
  }

  return result.data;
}
