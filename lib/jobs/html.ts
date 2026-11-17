/**
 * Shared HTML helpers for job-source adapters (docs/ARCHITECTURE.md §13.6.2).
 *
 * `stripHtml` moved here unchanged from the v1 `lib/jobs/themuse.ts`.
 * `decodeHtmlEntities` is for sources that return entity-escaped HTML
 * (Greenhouse's `content` is `&lt;p&gt;...`): decode first, then strip.
 */

/**
 * Strips HTML tags from a rich-text job description down to plain text,
 * since `job_descriptions.description` is a plain-text column fed into
 * Claude prompts. Deliberately a small regex-based stripper rather than a
 * new dependency: the input is a moderately well-formed HTML fragment from
 * a known API, never rendered as HTML anywhere, so it needs no sanitizer.
 *
 * - Block-level tags (`</p>`, `<br>`, `</li>`, `</div>`) become newlines so
 *   paragraph/list structure survives as plain-text line breaks.
 * - All other tags are dropped.
 * - The handful of HTML entities The Muse's content actually uses are
 *   decoded; anything else is left as-is (better to leave a stray `&amp;`
 *   than silently corrupt text via a wrong guess).
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

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
};

/**
 * Decodes one level of HTML entities: numeric (`&#39;`, `&#x27;`) and the
 * common named ones above. Unknown named entities and invalid code points
 * (surrogates, > U+10FFFF, NUL) are left as written. One pass only, so
 * `&amp;lt;` becomes `&lt;`, not `<` (no double-decoding).
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (match, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (
        !Number.isFinite(codePoint) ||
        codePoint === 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}
