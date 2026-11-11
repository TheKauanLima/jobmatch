/**
 * Delimiter escaping and wrapping for untrusted prompt content, per
 * docs/ARCHITECTURE.md §13.5.5 (reviewer-blocking). Extends the v1 module
 * (§5) rather than replacing its approach.
 *
 * ---- The model ----
 * Every untrusted string (resume text, listing text, fetched page text) and
 * every untrusted-derived string (a machine-extracted profile, narration role
 * data) enters a prompt only through `wrapUntrusted(tag, text, attrs?)`. That
 * function:
 *   1. escapes `text` with `escapeUntrusted()` against every word in
 *      `RESERVED_TAG_WORDS`, not just its own tag, so no block can forge
 *      another block's open/close tag (cross-tag forgery); and
 *   2. wraps the result in `<tag ...attrs>` ... `</tag>`, where `tag` must be
 *      a reserved word and `attrs` are server-generated only (validated
 *      against a strict charset, so user text can never reach an attribute).
 *
 * The system prompt (`UNTRUSTED_DATA_RULES` in promptCommon.ts) tells Claude
 * that everything inside these tags is data, never instructions.
 *
 * ---- What `escapeUntrusted()` neutralizes ----
 * Any open, close, or self-closing tag head for a reserved word, in one pass:
 *   - case-insensitive (`</RESUME_TEXT>`);
 *   - whitespace around and *within* the word (`</ resume_te xt >`,
 *     `</resume_\ntext>`), since an attacker controls the exact bytes;
 *   - invisible characters spliced into the word (every
 *     `Default_Ignorable_Code_Point`, stripped from the whole text first);
 *   - Unicode look-alikes folded by NFKC (math letters, full-width or
 *     small-form brackets), see `escapeUntrusted`;
 *   - repeated slashes (`<//resume_text>`);
 *   - attributes (`<job_posting id="J1">`, `<resume_text role="system">`);
 *   - an unterminated tag head (`</resume_text` at end of text or before a
 *     newline), which a model could still read as a delimiter.
 * The `<` (and the closing `>`, if present) are replaced with full-width
 * look-alikes (`＜` U+FF1C, `＞` U+FF1E). Everything between them is kept
 * verbatim, so no submitted text is lost and quoted-back text stays readable,
 * but it no longer parses as one of our delimiters. Unrelated angle-bracket
 * text (`<React>`, `C++ <templates>`, `<resume_textual>`) is untouched.
 */

/** Tags that carry meaning in Kalify prompts (§13.5.5 item 1). */
export const RESERVED_TAG_WORDS = [
  "resume_text",
  "job_description_text",
  "job_posting",
  "candidate_profile",
  "fetched_page_text",
  "role_data",
  "market_data",
] as const;

export type ReservedTagWord = (typeof RESERVED_TAG_WORDS)[number];

/**
 * Invisible code points an adversary could splice into a tag word to defeat
 * a whitespace-tolerant regex (`\s` matches none of them), or use to hide
 * instructions from a human reviewer while the model still reads them.
 *
 * We strip the whole Unicode `Default_Ignorable_Code_Point` property rather
 * than a hand-picked list. The M1.1 hand-written list missed U+034F, U+061C,
 * the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), U+17B4/5, and the
 * variation selectors (U+FE00–FE0F, U+E0100–E01EF), as the M1.1 review found.
 * The property is a superset of the earlier sets: soft hyphen, zero-width
 * space/joiners, LRM/RLM, bidi controls, word joiner and invisible
 * operators, BOM, Mongolian vowel separator, and the U+E0000 "tag" block used
 * for "ASCII smuggling" aimed at LLMs. None carry meaning in resume or
 * listing text. The cost is that emoji sequences lose joiners and variation
 * selectors, which is harmless for analysis.
 *
 * Built with the RegExp constructor because TypeScript would otherwise reject
 * a property-escape literal at the ES2017 target.
 */
export const INVISIBLE_CHARS_PATTERN = new RegExp("\\p{Default_Ignorable_Code_Point}", "gu");

/**
 * Shared with `normalizeForQuoteMatch` (semanticValidation.ts), so a quote
 * copied from escaped prompt text still matches the stored source.
 */
export function stripInvisibleChars(raw: string): string {
  return raw.replace(INVISIBLE_CHARS_PATTERN, "");
}

/**
 * Regex-source fragment for "any run of whitespace" wherever tag matching
 * tolerates whitespace. Uses the Unicode `White_Space` property (requires the
 * `u` flag), not JS `\s`: `\s` is ECMAScript WhiteSpace + LineTerminator and
 * misses U+0085 NEXT LINE, which survives both NFKC and Default_Ignorable
 * stripping, so `</resu\u0085me_text>` would otherwise slip through (M1.3 QA
 * bug B1). It is not a strict superset of `\s`: `\s` also matches U+FEFF
 * (BOM / ZERO WIDTH NO-BREAK SPACE), which is not White_Space. That gap is
 * harmless here because U+FEFF is Default_Ignorable_Code_Point, so
 * `stripInvisibleChars` has already removed it before tag matching runs.
 */
const TAG_WS = "\\p{White_Space}*";

/**
 * Regex fragment matching `word` with arbitrary whitespace between every
 * character (`res\nume_text`, `resume_te xt`, `resu\u0085me_text`).
 */
function buildTolerantWordPattern(word: string): string {
  return word
    .split("")
    .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(TAG_WS);
}

/**
 * One pattern for every reserved word (longest first, so no word can shadow a
 * longer one sharing its prefix):
 *
 *   <  WS*  (/WS*)*  (word1|word2|...)  (?![letter/digit/_])  [^<>]*  >?
 *
 * - `WS*` is `TAG_WS` (`\p{White_Space}*`, not `\s*`; see above), used for
 *   every whitespace-tolerant position, including inside each word.
 * - `(/WS*)*` accepts any number of slashes (`<//resume_text>`), not just one.
 * - `(?![\p{L}\p{N}_])` keeps `<resume_textual>` and `<job_postings>` out.
 * - `[^<>]*` is the attribute / trailing-whitespace / self-closing-slash
 *   region (the §13.5.5 pattern's `(\s[^>]*)?\s*`). It also stops at the next
 *   `<`, so an unterminated head (`</resume_text` followed by more text) is
 *   still caught without swallowing a following tag.
 * - `>?` makes the closing bracket optional (unterminated heads).
 */
const RESERVED_TAG_PATTERN = new RegExp(
  `<${TAG_WS}(?:\\/${TAG_WS})*(?:${[...RESERVED_TAG_WORDS]
    .sort((a, b) => b.length - a.length)
    .map(buildTolerantWordPattern)
    .join("|")})(?![\\p{L}\\p{N}_])[^<>]*>?`,
  "giu",
);

const FULLWIDTH_LT = "＜";
const FULLWIDTH_GT = "＞";

/**
 * Neutralizes every reserved delimiter tag inside untrusted text, in one
 * pass (see the module docstring).
 *
 * The text is NFKC-normalized first, then invisible characters are
 * stripped, and only then matched. NFKC folds look-alikes a model would
 * still read as our delimiters into ASCII, so they get neutralized like the
 * real thing: mathematical alphanumerics (`</𝐫esume_text>`), full-width and
 * small-form brackets (`＜/resume_text＞`, `﹤/resume_text﹥`), the Kelvin
 * sign, the long s, and so on. The returned text is therefore NFKC, plus our
 * full-width `＜ ＞` replacements. `normalizeForQuoteMatch` applies the same
 * NFKC and invisible-character normalization to both sides, so quotes Claude
 * copies from the prompt still match the stored source. Cross-script
 * homoglyphs (e.g. Cyrillic `е`) are not folded by NFKC, which is accepted.
 *
 * Idempotent: escaping already-escaped text returns it unchanged. NFKC turns
 * our `＜ ＞` back into `< >`, and the pattern immediately re-neutralizes them.
 */
export function escapeUntrusted(raw: string): string {
  return stripInvisibleChars(raw.normalize("NFKC")).replace(RESERVED_TAG_PATTERN, (match) => {
    const head = FULLWIDTH_LT + match.slice(1);
    return head.endsWith(">") ? head.slice(0, -1) + FULLWIDTH_GT : head;
  });
}

/** Attribute names/values are server-generated ids/enums only, e.g. `id="J1"`. */
const ATTR_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const ATTR_VALUE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export class UnsafePromptAttributeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePromptAttributeError";
  }
}

/**
 * The only way untrusted content enters a prompt (§13.5.5 item 2). Escapes
 * `text` against all reserved words and wraps it in `tag`.
 *
 * `attrs` must be server-generated (opaque handles like `J1`, enums). This
 * is enforced: a name or value outside the strict charset throws
 * `UnsafePromptAttributeError` instead of being escaped, since a value that
 * fails the check is a programming error (user text routed into an
 * attribute), not data to sanitize.
 */
export function wrapUntrusted(
  tag: ReservedTagWord,
  text: string,
  attrs?: Readonly<Record<string, string>>,
): string {
  if (!(RESERVED_TAG_WORDS as readonly string[]).includes(tag)) {
    throw new UnsafePromptAttributeError(`"${String(tag)}" is not a reserved prompt tag.`);
  }

  let attrString = "";
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (!ATTR_NAME_PATTERN.test(name)) {
      throw new UnsafePromptAttributeError("Prompt tag attribute name is not server-safe.");
    }
    if (!ATTR_VALUE_PATTERN.test(value)) {
      throw new UnsafePromptAttributeError(
        `Prompt tag attribute "${name}" value is not server-safe.`,
      );
    }
    attrString += ` ${name}="${value}"`;
  }

  return `<${tag}${attrString}>\n${escapeUntrusted(text)}\n</${tag}>`;
}
