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
 *   - invisible characters spliced into the word (stripped from the whole
 *     text first, see `INVISIBLE_CHAR_RANGES`);
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
 * Invisible / zero-width / formatting code points an adversary could splice
 * into a tag word to defeat a whitespace-tolerant regex (`\s` matches none
 * of them), or use to hide instructions from a human reviewer while the
 * model still reads them. Built from numeric code points so the set is
 * unambiguous to audit. Stripped from the whole text before matching. None
 * carry meaning in resume or listing content.
 *   - U+00AD soft hyphen
 *   - U+180E Mongolian vowel separator
 *   - U+200B–U+200F zero-width space / non-joiner / joiner, LRM, RLM
 *   - U+202A–U+202E bidi embedding / override controls
 *   - U+2060–U+2064 word joiner, invisible operators
 *   - U+2066–U+2069 bidi isolate controls
 *   - U+FEFF zero-width no-break space / BOM
 *   - U+E0000–U+E007F Unicode "tag" characters (used for invisible-text
 *     "ASCII smuggling" aimed at LLMs)
 * Every code point in the v1 set (U+200B, U+200C, U+200D, U+2060, U+FEFF,
 * U+00AD) is still covered.
 */
const INVISIBLE_CHAR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

function codePointClassPart([from, to]: readonly [number, number]): string {
  const hex = (cp: number) => `\\u{${cp.toString(16)}}`;
  return from === to ? hex(from) : `${hex(from)}-${hex(to)}`;
}

/** Exported for reuse by `normalizeForQuoteMatch` (semanticValidation.ts). */
export const INVISIBLE_CHARS_PATTERN = new RegExp(
  `[${INVISIBLE_CHAR_RANGES.map(codePointClassPart).join("")}]`,
  "gu",
);

export function stripInvisibleChars(raw: string): string {
  return raw.replace(INVISIBLE_CHARS_PATTERN, "");
}

/**
 * Regex fragment matching `word` with arbitrary whitespace between every
 * character (`res\nume_text`, `resume_te xt`).
 */
function buildTolerantWordPattern(word: string): string {
  return word
    .split("")
    .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
}

/**
 * One pattern for every reserved word (longest first, so no word can shadow a
 * longer one sharing its prefix):
 *
 *   <  \s*  /?  \s*  (word1|word2|...)  (?![letter/digit/_])  [^<>]*  >?
 *
 * - `(?![\p{L}\p{N}_])` keeps `<resume_textual>` and `<job_postings>` out.
 * - `[^<>]*` is the attribute / trailing-whitespace / self-closing-slash
 *   region (the §13.5.5 pattern's `(\s[^>]*)?\s*`). It also stops at the next
 *   `<`, so an unterminated head (`</resume_text` followed by more text) is
 *   still caught without swallowing a following tag.
 * - `>?` makes the closing bracket optional (unterminated heads).
 */
const RESERVED_TAG_PATTERN = new RegExp(
  `<\\s*\\/?\\s*(?:${[...RESERVED_TAG_WORDS]
    .sort((a, b) => b.length - a.length)
    .map(buildTolerantWordPattern)
    .join("|")})(?![\\p{L}\\p{N}_])[^<>]*>?`,
  "giu",
);

const FULLWIDTH_LT = "＜";
const FULLWIDTH_GT = "＞";

/**
 * Neutralizes every reserved delimiter tag inside untrusted text, in one
 * pass (see the module docstring). Idempotent: escaping already-escaped text
 * is a no-op.
 */
export function escapeUntrusted(raw: string): string {
  return stripInvisibleChars(raw).replace(RESERVED_TAG_PATTERN, (match) => {
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
