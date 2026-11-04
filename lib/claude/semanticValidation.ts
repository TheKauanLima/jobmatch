/**
 * Shared semantic-validation helpers, per docs/ARCHITECTURE.md §13.5.6.
 *
 * Structured outputs guarantee the output's *shape* (the JSON matches the
 * schema's types and required keys). They don't guarantee *meaning*: a
 * score may be out of range (the SDK strips numeric bounds from the JSON
 * schema it sends, see the "Verified" note in §13.5.2), a string may be
 * empty, a "verbatim quote" may not appear in the source, a handle may be
 * invented. An injection attempt can still plant values like these inside
 * otherwise-valid fields. Every `validateX` re-checks them with these helpers.
 *
 * Convention: "invalid" outcomes throw `ClaudeInvalidOutputError` (retryable
 * once, §13.5.2). "Drop" outcomes return a filtered value plus a count, which
 * callers log or persist (`dropped_items`) so prompt regressions show up in data.
 *
 * PII: thrown messages name fields and counts only, never values.
 */

import { ClaudeInvalidOutputError } from "@/lib/claude/errors";
import { stripInvisibleChars } from "@/lib/claude/promptEscaping";

// ---------------------------------------------------------------------------
// Quote matching
// ---------------------------------------------------------------------------

const SINGLE_QUOTES = /[‘’‚‛′‵]/g;
const DOUBLE_QUOTES = /[“”„‟″‶]/g;
// en dash, em dash, figure dash, horizontal bar, minus sign, small/fullwidth hyphen-minus
const DASHES = /[‐‑‒–—―−﹘﹣－]/g;
// Bullet glyphs at line start: • ▪ ◦ · * - (after dash normalization, so – — count too)
const LINE_START_BULLETS = /^[\s•▪◦·*-]+/;

/**
 * Normalization applied to both sides of a quote match (§13.5.6): NFKC;
 * invisible characters removed (the same set `escapeUntrusted` strips from
 * prompt text, so a quote taken from the escaped prompt still matches the
 * stored source); lowercase; curly to straight quotes; en/em dashes to `-`;
 * bullet glyphs stripped at line start; whitespace collapsed.
 */
export function normalizeForQuoteMatch(s: string): string {
  return stripInvisibleChars(s.normalize("NFKC"))
    .toLowerCase()
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(LINE_START_BULLETS, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when `quote` (normalized) is a substring of `source` (normalized). An
 * empty or whitespace-only quote never "appears", since it would trivially
 * match anything.
 */
export function quoteAppearsIn(quote: string, source: string): boolean {
  const q = normalizeForQuoteMatch(quote);
  return q.length > 0 && normalizeForQuoteMatch(source).includes(q);
}

/**
 * Same as `quoteAppearsIn`, but normalizes `source` once, for validators
 * that check many quotes against one resume or listing.
 */
export function createQuoteMatcher(source: string): (quote: string) => boolean {
  const normalizedSource = normalizeForQuoteMatch(source);
  return (quote: string) => {
    const q = normalizeForQuoteMatch(quote);
    return q.length > 0 && normalizedSource.includes(q);
  };
}

// ---------------------------------------------------------------------------
// Handles, slugs, numbers
// ---------------------------------------------------------------------------

/**
 * Asserts the model returned exactly the provided opaque handles (e.g.
 * `J1..J5`), each exactly once (§13.5.6 rerank rule). Throws
 * `ClaudeInvalidOutputError` otherwise. Handles are server-generated, so it's
 * safe to name them in the message.
 */
export function assertHandlesExact(
  returned: readonly string[],
  expected: readonly string[],
): void {
  const expectedSet = new Set(expected);
  const seen = new Set<string>();
  const problems: string[] = [];

  for (const handle of returned) {
    if (!expectedSet.has(handle)) {
      problems.push("unexpected handle");
    } else if (seen.has(handle)) {
      problems.push(`duplicate ${handle}`);
    }
    seen.add(handle);
  }
  for (const handle of expectedSet) {
    if (!seen.has(handle)) {
      problems.push(`missing ${handle}`);
    }
  }

  if (problems.length > 0) {
    throw new ClaudeInvalidOutputError(
      `Output handles do not match the provided set (${problems.join(", ")}).`,
    );
  }
}

/**
 * Splits slugs into those inside the allowed vocabulary and those outside
 * (§13.5.6: "null the slug" / "drop the comment", depending on the task).
 */
export function slugsInVocabulary(
  slugs: readonly string[],
  vocabulary: ReadonlySet<string> | readonly string[],
): { kept: string[]; dropped: string[] } {
  const allowed: ReadonlySet<string> =
    vocabulary instanceof Set ? vocabulary : new Set(vocabulary as readonly string[]);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const slug of slugs) {
    (allowed.has(slug) ? kept : dropped).push(slug);
  }
  return { kept, dropped };
}

/**
 * Statistic-like number phrases (§13.5.4(5) numbers rule): digits followed by
 * `%`, "percent"/"per cent", "out of", or "of N". Returns the matched
 * fragments; an empty array means the text is clean. Used to drop narration
 * comments that state numbers Claude was told not to state.
 */
const FABRICATED_NUMBER_PATTERNS: readonly RegExp[] = [
  /\d[\d,.]*\s*(?:%|％|percent\b|per\s+cent\b)/gi,
  /\d[\d,.]*\s+out\s+of\b/gi,
  /\bout\s+of\s+\d[\d,.]*/gi,
  /\bof\s+\d[\d,.]*/gi,
];

export function fabricatedNumbers(text: string): string[] {
  const normalized = text.normalize("NFKC");
  const found: string[] = [];
  for (const pattern of FABRICATED_NUMBER_PATTERNS) {
    for (const match of normalized.matchAll(pattern)) {
      found.push(match[0]);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Scalars and simple lists
// ---------------------------------------------------------------------------

/**
 * Asserts `value` is an integer in `[min, max]`. Throws
 * `ClaudeInvalidOutputError` naming `field` (not the value) otherwise.
 * Out-of-range values are rejected, never clamped: silently "fixing" an
 * out-of-contract value is itself a way an injected value could slip through.
 */
export function assertIntInRange(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ClaudeInvalidOutputError(`Output field "${field}" must be an integer ${min}..${max}.`);
  }
  return value;
}

/** Asserts a required string is non-empty after trimming; returns it trimmed. */
export function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClaudeInvalidOutputError(`Output field "${field}" must be a non-empty string.`);
  }
  return value.trim();
}

/** Trims every entry and drops empty ones, reporting how many were dropped. */
export function cleanStringList(values: readonly string[]): { kept: string[]; dropped: number } {
  const kept = values.map((v) => v.trim()).filter((v) => v.length > 0);
  return { kept, dropped: values.length - kept.length };
}
