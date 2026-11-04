/**
 * Per-task Claude configuration, per docs/ARCHITECTURE.md §13.5.3.
 *
 * The model is a per-task constant, not an env var (§13.18), so a model
 * change is a one-line, reviewable diff. `callStructured()` reads
 * everything it sends (model, effort, max_tokens, timeout) from here.
 * Callers pass only a task name.
 *
 * Opus 5.5 constraints this table relies on: no sampling parameters, no
 * forced tool choice, and no assistant prefill. Thinking can't
 * be disabled, so depth is controlled only by `effort`. Every `maxTokens`
 * here is <= 20 000, which stays under the SDK's non-streaming size guard
 * (it throws above ~21 333 tokens when no explicit timeout is passed). We
 * also always pass an explicit `timeout`, which bypasses that estimate
 * entirely. See the "Verified" note in §13.5.2.
 */

import type { ReservedTagWord } from "@/lib/claude/promptEscaping";

export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * `sync`: called inline via `callStructured()`.
 * `batch_for_shared_external`: shared, externally ingested listing text goes
 * through the Message Batches API (lib/claude/batches.ts, M2.2). Every other
 * path for this task (user-submitted, private, URL import, fit check) still
 * runs sync. Resume data never goes through Batches (§13.5.3).
 */
export type ClaudeTaskMode = "sync" | "batch_for_shared_external";

export type ClaudeTaskConfig = {
  readonly model: string;
  readonly effort: ClaudeEffort;
  readonly maxTokens: number;
  /** Per-request timeout passed to the SDK (also bypasses its non-streaming guard). */
  readonly timeoutMs: number;
  readonly mode: ClaudeTaskMode;
  /** Persisted alongside outputs so prompt regressions can be traced in data. */
  readonly promptVersion: string;
  /** The untrusted (or untrusted-derived) tags this task's prompt carries, for review. */
  readonly untrustedInputs: readonly ReservedTagWord[];
  /** v1 tasks kept alive until M3.9 removes the v1 routes. */
  readonly legacy?: true;
};

export const CLAUDE_TASKS = {
  // ---- v2 tasks (§13.5.3 table; implemented in later milestones) ----
  extractResumeProfile: {
    model: CLAUDE_DEFAULT_MODEL,
    effort: "medium",
    maxTokens: 16_000,
    timeoutMs: 160_000,
    mode: "sync",
    promptVersion: "profile-v1",
    untrustedInputs: ["resume_text"],
  },
  critiqueResume: {
    model: CLAUDE_DEFAULT_MODEL,
    effort: "high",
    maxTokens: 20_000,
    timeoutMs: 190_000,
    mode: "sync",
    promptVersion: "critique-v1",
    untrustedInputs: ["resume_text", "candidate_profile"],
  },
  extractJobRequirements: {
    // §13.19 Q2: candidate for a cheaper model after the M2.5 eval.
    model: CLAUDE_DEFAULT_MODEL,
    effort: "low",
    maxTokens: 8_000,
    timeoutMs: 140_000,
    mode: "batch_for_shared_external",
    promptVersion: "jobreq-v1",
    untrustedInputs: ["job_description_text", "fetched_page_text"],
  },
  rerankJobsForRole: {
    model: CLAUDE_DEFAULT_MODEL,
    effort: "medium",
    maxTokens: 16_000,
    timeoutMs: 160_000,
    mode: "sync",
    promptVersion: "rerank-v1",
    untrustedInputs: ["candidate_profile", "job_posting"],
  },
  narrateRoleFit: {
    model: CLAUDE_DEFAULT_MODEL,
    effort: "medium",
    maxTokens: 12_000,
    timeoutMs: 160_000,
    mode: "sync",
    promptVersion: "narrate-v1",
    untrustedInputs: ["candidate_profile", "role_data"],
  },
  assessJobFit: {
    model: CLAUDE_DEFAULT_MODEL,
    effort: "high",
    maxTokens: 20_000,
    timeoutMs: 190_000,
    mode: "sync",
    promptVersion: "fitcheck-v1",
    untrustedInputs: ["resume_text", "candidate_profile", "job_description_text"],
  },

  // ---- v1 tasks (lib/claude/prompts/*), migrated in M1.1, deleted in M3.9 ----
  analyzeResume: {
    model: CLAUDE_DEFAULT_MODEL,
    effort: "medium",
    maxTokens: 16_000,
    timeoutMs: 160_000,
    mode: "sync",
    promptVersion: "analyze-v2",
    untrustedInputs: ["resume_text"],
    legacy: true,
  },
  matchResumeToJob: {
    model: CLAUDE_DEFAULT_MODEL,
    effort: "medium",
    maxTokens: 16_000,
    timeoutMs: 160_000,
    mode: "sync",
    promptVersion: "match-v2",
    untrustedInputs: ["resume_text", "job_description_text"],
    legacy: true,
  },
} as const satisfies Record<string, ClaudeTaskConfig>;

export type ClaudeTaskName = keyof typeof CLAUDE_TASKS;

export function getTaskConfig(task: ClaudeTaskName): ClaudeTaskConfig {
  return CLAUDE_TASKS[task];
}
