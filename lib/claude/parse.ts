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
