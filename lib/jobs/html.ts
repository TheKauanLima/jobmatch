/**
 * Plain-text helpers for HTML job-description fields from external job
 * boards (docs/ARCHITECTURE.md §7.7.4). `job_descriptions.description` is a
 * plain-text column fed directly into the Claude matching prompt and only
 * ever rendered as React text nodes (§2), so markup is stripped at ingestion
 * time. A small regex-based approach rather than a parser dependency: the
 * input comes from a closed set of known APIs, and neither function's output
 * is ever rendered as HTML.
 */

/**
 * Strips HTML tags from a rich-text job description down to plain text.
 * (Moved unchanged from the deleted `lib/jobs/themuse.ts`, §7.7.8.)
 *
 * - Block-level tags (`</p>`, `<br>`, `</li>`, `</div>`) become newlines so
 *   paragraph/list structure survives as plain-text line breaks.
 * - All other tags are dropped.
 * - A handful of common HTML entities are decoded; anything else is left
 *   as-is (better to leave a stray entity than silently corrupt text via a
 *   wrong guess). Use `decodeHtmlEntities` first for markup that arrives
 *   entity-escaped (Greenhouse).
 * - Runs of 3+ blank lines collapse to 2 (a single blank line separating
 *   paragraphs), and leading/trailing whitespace is trimmed.
 */
export function stripHtml(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*\/\s*li\s*>/gi, "");

  const withoutTags = withBreaks.replace(/<[^>]+>/g, "");

  const decoded = withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");

  return decoded
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  // A plain space rather than U+00A0: the output is plain text for the
  // matching prompt, where a non-breaking space has no meaning and would
  // survive `stripHtml`'s whitespace collapsing.
  nbsp: " ",
};

/** Highest valid Unicode code point. */
const MAX_CODE_POINT = 0x10ffff;

function fromCodePoint(codePoint: number, original: string): string {
  if (
    !Number.isFinite(codePoint) ||
    codePoint <= 0 ||
    codePoint > MAX_CODE_POINT ||
    // Lone surrogates aren't valid characters on their own.
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return original;
  }
  return String.fromCodePoint(codePoint);
}

/**
 * Decodes HTML entities in one pass: the named entities
 * `&lt; &gt; &amp; &quot; &apos; &nbsp;` and numeric references (`&#NNN;`
 * decimal, `&#xHH;` hex, including `&#39;`). Unknown named entities and
 * invalid code points are left as-is.
 *
 * Single pass on purpose: `&amp;lt;` decodes to the literal text `&lt;`, not
 * to `<`. Greenhouse's `content` field is HTML that has itself been
 * entity-escaped (`&lt;p&gt;…`), so the sync runs this *before* `stripHtml`.
 */
export function decodeHtmlEntities(s: string): string {
  return s.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g,
    (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec !== undefined) {
        return fromCodePoint(Number.parseInt(dec, 10), match);
      }
      if (hex !== undefined) {
        return fromCodePoint(Number.parseInt(hex, 16), match);
      }
      const named = name !== undefined ? NAMED_ENTITIES[name] : undefined;
      return named ?? match;
    },
  );
}
