/**
 * Shared delimiter-escaping helper used by every `lib/claude/prompts/*`
 * module that wraps untrusted user-supplied text in an XML-ish delimiter
 * tag before sending it to Claude (see the "Injection-hardening approach"
 * docstring in `lib/claude/prompts/analyzeResume.ts` for the full three-
 * layer rationale — this module is layer 2, delimiter-escaping, factored
 * out so it isn't duplicated per-tag-name).
 *
 * Originally lived only in `analyzeResume.ts` scoped to the literal word
 * "resume_text". `matchResumeToJob.ts` (M5) needs the exact same escaping
 * behavior for a SECOND, independently-untrusted tag word
 * ("job_description_text") — job descriptions are shared, community-
 * submitted content (any authenticated user can submit one, per
 * docs/ARCHITECTURE.md §1/§5) that gets matched against OTHER users'
 * resumes, so it's just as adversarial-capable as resume text and must get
 * the identical hardening treatment, not a weaker copy-pasted variant.
 * Generalized here over an arbitrary `tagWord` so both call sites share one
 * audited implementation.
 */

/**
 * Code points of zero-width/invisible Unicode characters an adversary could
 * splice into the literal tag word to defeat a naive whitespace-only
 * tolerant regex — `\s` does not match any of these in JavaScript. Built
 * from numeric code points (via `String.fromCharCode`) rather than
 * embedding the literal invisible characters in this file's source, so the
 * exact set is unambiguous to read/audit and can't be silently mangled by
 * an editor/encoding round-trip:
 *   - U+200B zero-width space
 *   - U+200C zero-width non-joiner
 *   - U+200D zero-width joiner
 *   - U+2060 word joiner
 *   - U+FEFF zero-width no-break space / BOM
 *   - U+00AD soft hyphen
 * Stripped from the text entirely before tag-matching, since none of these
 * carry legitimate meaning in resume or job-description content.
 */
const INVISIBLE_CHAR_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad];
const INVISIBLE_CHARS = new RegExp(
  `[${INVISIBLE_CHAR_CODE_POINTS.map((code) => String.fromCharCode(code)).join("")}]`,
  "g",
);

/**
 * Builds a regex fragment matching the literal `word` that tolerates
 * arbitrary whitespace *between every character* (not just around the whole
 * tag) — e.g. `res\nume_text` or `resume_te xt` must still match. Without
 * this, splitting the word itself (rather than just padding around the tag)
 * bypasses escaping entirely, since an attacker fully controls the exact
 * bytes of their submitted content.
 */
function buildTolerantWordPattern(word: string): string {
  return word
    .split("")
    .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
}

/**
 * Neutralizes any literal occurrence of the `<${tagWord}>` /
 * `</${tagWord}>` delimiter tags inside user-supplied content, so submitted
 * text cannot forge a premature close tag (or a fake open tag) to break out
 * of its data block. Matching is case-insensitive and tolerant of
 * whitespace both around the tag (e.g. `</ resume_text >`) AND *within* the
 * literal word itself (e.g. `</resume_\ntext>`, `</resume_te xt>`), plus
 * zero-width/invisible Unicode characters spliced into the word, since an
 * attacker controls the exact bytes. Replaces matches with full-width
 * look-alike characters so the text remains readable if quoted back (e.g.
 * in an error message or a model-generated rationale), but is no longer
 * parseable as our delimiter.
 */
export function escapeDelimitedText(raw: string, tagWord: string): string {
  const withoutInvisibles = raw.replace(INVISIBLE_CHARS, "");
  const wordPattern = buildTolerantWordPattern(tagWord);
  const tagPattern = new RegExp(`<\\s*(\\/)?\\s*${wordPattern}\\s*>`, "gi");

  return withoutInvisibles.replace(tagPattern, (_match, closing: string | undefined) =>
    closing ? `＜/${tagWord}＞` : `＜${tagWord}＞`,
  );
}
