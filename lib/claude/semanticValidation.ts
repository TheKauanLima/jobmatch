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
// Whitespace in this module means the Unicode White_Space property (`u` flag),
// not JS `\s`, which misses U+0085 NEXT LINE (same bug class as M1.3 QA bug
// B1; see TAG_WS in promptEscaping.ts). U+FEFF, which `\s` matches but
// White_Space doesn't, is Default_Ignorable and is removed by
// stripInvisibleChars before the quote-matching patterns run.
// fabricatedNumbers doesn't strip invisibles, so its patterns use NUM_WS,
// which adds U+FEFF back to keep the old `\s` coverage.
// Built with the RegExp constructor because TypeScript rejects
// property-escape literals at the ES2017 target.
const WS = "\\p{White_Space}";
const NUM_WS = "[\\p{White_Space}\\uFEFF]";
const WHITESPACE_RUN = new RegExp(`${WS}+`, "gu");

// Bullet glyphs at line start: • ▪ ◦ · * - (after dash normalization, so – — count too)
const LINE_START_BULLETS = new RegExp(`^[${WS}•▪◦·*-]+`, "u");

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
    .replace(WHITESPACE_RUN, " ")
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
// Locating a quote in the original source (§13.13.2 "Displaying quoted text")
// ---------------------------------------------------------------------------

/** A half-open span `[start, end)` of UTF-16 offsets into the original source. */
export type SourceSpan = { start: number; end: number };

const GRAPHEME_SEGMENTER = new Intl.Segmenter("und", { granularity: "grapheme" });
const WHITE_SPACE_CHAR = new RegExp(`^${WS}$`, "u");
const LINE_BREAK_CHAR = /^[\r\n]$/;
// The LINE_START_BULLETS character set, applied one character at a time.
const LINE_START_BULLET_CHAR = new RegExp(`^[${WS}•▪◦·*-]$`, "u");

/**
 * `normalizeForQuoteMatch` with an offset map: the normalized text, plus for
 * each UTF-16 unit of it the `[start, end)` span of the original text it
 * came from.
 *
 * The steps are the same, in the same order (NFKC, invisible-character
 * stripping, lowercase, quote and dash folding, per-line bullet stripping,
 * line joining, whitespace collapsing, trimming). The first five are applied
 * per grapheme cluster rather than to the whole string, so every output
 * character maps back to exactly one cluster of the original. A cluster that
 * expands (`ﬁ` -> `fi`, `½` -> `1⁄2`) maps all of its output characters to
 * the whole cluster, and a cluster that vanishes (an invisible character)
 * maps to nothing.
 *
 * Per-cluster NFKC equals whole-string NFKC except for compositions that
 * cross a cluster boundary, which Unicode practically rules out (combining
 * marks and Hangul vowel/trailing jamo extend a cluster). Lowercasing per
 * cluster loses only context rules like the Greek final sigma. Neither
 * matters, because `locateQuoteInSource` normalizes the quote with this same
 * function, so both sides are always folded identically.
 */
function normalizeWithOffsets(source: string): { text: string; starts: number[]; ends: number[] } {
  type Unit = { ch: string; start: number; end: number };

  // Steps 1-5, per grapheme cluster.
  const folded: Unit[] = [];
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(source)) {
    const out = stripInvisibleChars(segment.normalize("NFKC"))
      .toLowerCase()
      .replace(SINGLE_QUOTES, "'")
      .replace(DOUBLE_QUOTES, '"')
      .replace(DASHES, "-");
    for (const ch of out) {
      folded.push({ ch, start: index, end: index + segment.length });
    }
  }

  // Steps 6-7: strip bullets/whitespace at each line start, turn line breaks
  // into spaces (`split(/\r\n|\r|\n/).join(" ")`; a CRLF pair becomes two
  // spaces here, which the collapse below merges into one).
  const lined: Unit[] = [];
  let atLineStart = true;
  for (const unit of folded) {
    if (LINE_BREAK_CHAR.test(unit.ch)) {
      lined.push({ ...unit, ch: " " });
      atLineStart = true;
      continue;
    }
    if (atLineStart && LINE_START_BULLET_CHAR.test(unit.ch)) {
      continue;
    }
    atLineStart = false;
    lined.push(unit);
  }

  // Step 8: collapse whitespace runs to one space (spanning the whole run).
  const collapsed: Unit[] = [];
  for (const unit of lined) {
    if (WHITE_SPACE_CHAR.test(unit.ch)) {
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.ch === " ") {
        prev.end = unit.end;
      } else {
        collapsed.push({ ch: " ", start: unit.start, end: unit.end });
      }
    } else {
      collapsed.push(unit);
    }
  }

  // Step 9: trim.
  let first = 0;
  let last = collapsed.length;
  while (first < last && collapsed[first].ch === " ") first += 1;
  while (last > first && collapsed[last - 1].ch === " ") last -= 1;

  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const unit of collapsed.slice(first, last)) {
    text += unit.ch;
    // An astral character is two UTF-16 units; both map to the same span.
    for (let i = 0; i < unit.ch.length; i += 1) {
      starts.push(unit.start);
      ends.push(unit.end);
    }
  }
  return { text, starts, ends };
}

/**
 * Finds `quote` in `source` the way `quoteAppearsIn` does (both sides
 * normalized), and returns the span of the ORIGINAL `source` that matched,
 * or `null` if the quote doesn't appear or is empty after normalization.
 *
 * Callers store `source.slice(start, end)`: the user's exact characters
 * (`m²`, `™`, `½`, full-width digits, ligatures), never the NFKC quote Claude
 * returned (§13.13.2). The span starts at the first matched character and
 * ends after the last one, so it never includes a leading bullet or
 * surrounding whitespace. The first occurrence wins.
 *
 * Match against the full stored source, not a truncated prompt slice.
 */
export function locateQuoteInSource(quote: string, source: string): SourceSpan | null {
  return createQuoteLocator(source)(quote);
}

/**
 * Same as `locateQuoteInSource`, but normalizes `source` once, for
 * validators that locate many quotes in one resume.
 */
export function createQuoteLocator(source: string): (quote: string) => SourceSpan | null {
  const normalized = normalizeWithOffsets(source);
  return (quote: string) => {
    const q = normalizeWithOffsets(quote).text;
    if (q.length === 0) {
      return null;
    }
    const at = normalized.text.indexOf(q);
    if (at === -1) {
      return null;
    }
    return { start: normalized.starts[at], end: normalized.ends[at + q.length - 1] };
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
  new RegExp(`\\d[\\d,.]*${NUM_WS}*(?:%|％|percent\\b|per${NUM_WS}+cent\\b)`, "giu"),
  new RegExp(`\\d[\\d,.]*${NUM_WS}+out${NUM_WS}+of\\b`, "giu"),
  new RegExp(`\\bout${NUM_WS}+of${NUM_WS}+\\d[\\d,.]*`, "giu"),
  new RegExp(`\\bof${NUM_WS}+\\d[\\d,.]*`, "giu"),
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

/** A run of decimal digits, with internal `,` / `.` separators (`1,200`, `3.5`). */
const NUMBER_TOKEN = new RegExp("\\p{Nd}+(?:[.,]\\p{Nd}+)*", "gu");
/** A `[...]` placeholder (no nesting). An unclosed `[` protects nothing. */
const BRACKETED_PLACEHOLDER = /\[[^[\]]*\]/g;

function numberTokens(text: string): string[] {
  return [...text.matchAll(NUMBER_TOKEN)].map((m) => m[0]);
}

/**
 * Numbers in `rewrite` that are not in `original` and not inside a
 * `[...]` placeholder: the §13.5.6 critique fabrication guard ("a rewrite may
 * only use facts in the original line"). An empty array means the rewrite
 * adds no number.
 *
 * Both sides are NFKC-normalized first, so full-width digits and `m²` / `½`
 * compare equal to what Claude saw (`m2`, `1⁄2`). Thousands separators are
 * ignored when comparing (`1,200` = `1200`). Comparison is per whole token,
 * so `3` is "new" next to an original `30`.
 *
 * Limitation: only digit tokens are checked. Spelled-out numbers ("three",
 * "a dozen", "doubled") and number-like words are not detected; the prompt's
 * no-fabrication rule is the only guard against those.
 */
export function numbersIntroduced(rewrite: string, original: string): string[] {
  const canonical = (token: string) => token.replace(/,/g, "");
  const allowed = new Set(numberTokens(original.normalize("NFKC")).map(canonical));
  return numberTokens(rewrite.normalize("NFKC").replace(BRACKETED_PLACEHOLDER, " ")).filter(
    (token) => !allowed.has(canonical(token)),
  );
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
