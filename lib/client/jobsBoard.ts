/**
 * Pure, framework-free helpers for the jobs board (`app/jobs/**`,
 * `components/jobs/**`): URL state, relative dates, plain-text snippets,
 * description layout, and source labels/attribution.
 *
 * Everything here is deterministic given its inputs (`now`, locale and time
 * zone are fixed or injectable), so server rendering and client hydration
 * agree, and every branch is unit-testable without a DOM.
 *
 * Nothing in this file produces HTML. Job descriptions are untrusted text
 * (user-submitted or externally ingested), so they are only ever turned into
 * plain strings that React renders as text nodes.
 */

// ---------------------------------------------------------------------
// URL state: /jobs?q=<term>&level=<level>
// ---------------------------------------------------------------------

/**
 * Levels the level filter offers, per docs/ARCHITECTURE.md §7.4 and §7.7.3.
 * These are exactly the values `classifyStudentLevel`
 * (`lib/jobs/studentFilter.ts`) assigns during the Greenhouse/Lever sync
 * (`lib/jobs/sources/`), and are the student-relevant segment of
 * `JOB_DESCRIPTION_LEVELS`. Duplicated rather than imported so this client
 * helper doesn't pull server-side sync code into the browser bundle.
 */
export const JOB_LEVEL_FILTERS = ["Internship", "Entry Level"] as const;
export type JobLevelFilter = (typeof JOB_LEVEL_FILTERS)[number];

/**
 * Mirrors `JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH`
 * (`lib/supabase/queries/jobDescriptions.ts`). The API answers `400` above
 * this, so the board clamps instead of showing an error for a long pasted
 * URL. Kept in sync by a unit test.
 */
export const JOBS_SEARCH_MAX_LENGTH = 200;

export type JobsBoardQuery = {
  q: string | null;
  level: JobLevelFilter | null;
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function isJobLevelFilter(value: unknown): value is JobLevelFilter {
  return (
    typeof value === "string" &&
    (JOB_LEVEL_FILTERS as readonly string[]).includes(value)
  );
}

/**
 * Parses `/jobs` search params into the board's query state. Unknown levels
 * are ignored (treated as "All"), blank searches become `null`, and over-long
 * searches are clamped to what the API accepts.
 */
export function parseJobsSearchParams(params: RawSearchParams): JobsBoardQuery {
  const rawQ = firstValue(params.q)?.trim() ?? "";
  const q = rawQ ? rawQ.slice(0, JOBS_SEARCH_MAX_LENGTH).trim() : null;
  const rawLevel = firstValue(params.level);
  return { q, level: isJobLevelFilter(rawLevel) ? rawLevel : null };
}

/** Builds a `/jobs` href for the given state; omitted/empty values are dropped. */
export function buildJobsHref(query: Partial<JobsBoardQuery> = {}): string {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  if (q) params.set("q", q);
  if (query.level) params.set("level", query.level);
  const search = params.toString();
  return search ? `/jobs?${search}` : "/jobs";
}

/** Stable key for one search/filter combination (remounts paginated lists). */
export function jobsQueryKey(query: JobsBoardQuery): string {
  return `${query.level ?? "all"}:${query.q ?? ""}`;
}

/** Builds the `GET /api/job-descriptions` path for a page of results. */
export function buildJobsApiPath(
  query: JobsBoardQuery,
  cursor: string | null = null,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.level) params.set("level", query.level);
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  return search ? `/api/job-descriptions?${search}` : "/api/job-descriptions";
}

/**
 * Result-count line. The API has no total count (it fetches `limit + 1` to
 * know whether another page exists), so when more pages remain the count is
 * shown as "20+" rather than implying it's the total.
 */
export function formatResultSummary(input: {
  count: number;
  hasMore: boolean;
  q: string | null;
  level: JobLevelFilter | null;
}): string {
  const { count, hasMore, q, level } = input;
  const amount = hasMore ? `${count}+` : String(count);
  const noun = count === 1 && !hasMore ? "job" : "jobs";
  const levelPart = level ? ` ${level.toLowerCase()}` : "";
  const searchPart = q ? ` matching “${q}”` : "";
  return `${amount}${levelPart} ${noun}${searchPart}`;
}

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** The date a listing should be shown as "posted": the source's date if known. */
export function jobPostedAt(job: {
  posted_at: string | null;
  created_at: string;
}): string {
  return job.posted_at ?? job.created_at;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * "today" / "yesterday" / "3 days ago" / "2 weeks ago" / "4 months ago" /
 * "1 year ago". Future dates (clock skew) read as "today". Returns `null`
 * for an unparseable value so callers can omit the date entirely.
 */
export function formatRelativeDays(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;

  const days = Math.max(0, Math.floor((now - ms) / DAY_MS));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return plural(days, "day");
  if (days < 30) return plural(Math.floor(days / 7), "week");
  if (days < 365) return plural(Math.max(1, Math.floor(days / 30)), "month");
  return plural(Math.floor(days / 365), "year");
}

/**
 * Absolute calendar date, e.g. "Nov 18, 2026". Fixed locale and UTC so the
 * server render and client hydration produce identical text.
 */
export function formatAbsoluteDate(iso: string | null | undefined): string | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(ms));
}

// ---------------------------------------------------------------------
// Plain text: snippets and description blocks
// ---------------------------------------------------------------------

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      // Drop control characters and invalid code points rather than emit them.
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return " ";
      return String.fromCodePoint(code);
    }
    return ENTITY_MAP[body.toLowerCase()] ?? match;
  });
}

/**
 * Converts possibly-HTML text to plain text with line structure preserved:
 * block-level tags and `<br>` become line breaks, `<li>` becomes a "- "
 * bullet, every other tag is removed, and common entities are decoded.
 * `<script>`/`<style>` contents are dropped entirely. The output is still
 * rendered as a React text node, never as HTML; this only makes it readable.
 */
export function toPlainText(input: string | null | undefined): string {
  if (!input) return "";
  const withBreaks = input
    .replace(/\r\n?/g, "\n")
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n- ")
    .replace(/<\s*\/\s*li\s*>/gi, "")
    .replace(/<\s*\/?\s*(p|div|ul|ol|h[1-6]|section|article|tr)\b[^>]*>/gi, "\n");
  const withoutTags = withBreaks.replace(/<\/?[a-z][^>]*>/gi, "");
  return decodeEntities(withoutTags)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const BULLET_PATTERN = /^(?:[-*•‣▪◦·]|\d{1,2}[.)])\s+/;
/** A bullet marker with nothing after it (an empty list item). */
const BARE_BULLET_PATTERN = /^[-*•‣▪◦·]$/;

/**
 * One-paragraph preview for a listing card: plain text, bullets and line
 * breaks flattened, cut at a word boundary with an ellipsis.
 */
export function makeSnippet(
  input: string | null | undefined,
  maxLength = 180,
): string {
  const flat = toPlainText(input)
    .split("\n")
    .map((line) => line.replace(BULLET_PATTERN, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (flat.length <= maxLength) return flat;

  const cut = flat.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s.,;:!?\-–—]+$/, "")}…`;
}

export type DescriptionBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; items: string[] };

const HEADING_MAX_LENGTH = 60;

/**
 * Splits a description into readable blocks: paragraphs (separated by blank
 * lines; single line breaks kept as lines), bullet lists (runs of "- ",
 * "* ", "• " or "1." lines), and short standalone "Heading:" lines.
 */
export function toDescriptionBlocks(
  input: string | null | undefined,
): DescriptionBlock[] {
  const lines = toPlainText(input).split("\n");
  const blocks: DescriptionBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    if (
      paragraph.length === 1 &&
      paragraph[0].length <= HEADING_MAX_LENGTH &&
      /:$/.test(paragraph[0])
    ) {
      blocks.push({ type: "heading", text: paragraph[0].replace(/:$/, "") });
    } else {
      blocks.push({ type: "paragraph", lines: paragraph });
    }
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push({ type: "list", items: list });
    list = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    if (BARE_BULLET_PATTERN.test(line)) {
      continue;
    }
    if (BULLET_PATTERN.test(line)) {
      // A heading line directly above a list ("Requirements:") is still a heading.
      flushParagraph();
      const item = line.replace(BULLET_PATTERN, "").trim();
      if (item) list.push(item);
      continue;
    }
    flushList();
    // A "Heading:" line directly followed by text still reads as a heading.
    if (
      paragraph.length === 0 &&
      line.length <= HEADING_MAX_LENGTH &&
      /:$/.test(line)
    ) {
      blocks.push({ type: "heading", text: line.replace(/:$/, "") });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

// ---------------------------------------------------------------------
// Sources, attribution, and outbound links
// ---------------------------------------------------------------------

export type JobSourceInfo = {
  /** Short badge text. */
  label: string;
  kind: "community" | "external";
  /** Badge tooltip / screen-reader description of where the listing came from. */
  description: string;
  /** Required attribution, rendered as a link on the detail page. */
  attribution: { text: string; href: string } | null;
  /** Label for the outbound link to `source_url`. */
  applyLabel: string;
};

/**
 * Display metadata per `job_descriptions.source`.
 *
 * Greenhouse and Lever listings are the employer's own postings, fetched from
 * the company's public job board (docs/ARCHITECTURE.md §7.7.9). Neither
 * provider publishes attribution terms, so they're framed as "Employer
 * posting" with no attribution link; the "Opens {host}" line on the detail
 * page shows where the apply link actually goes.
 *
 * `themuse` is legacy (source dropped 2026-11-20, §7.7.8) but kept because
 * older rows still appear via existing matches. The Muse's API terms require
 * linking back to The Muse (§7.1, §13.6.7), so those rows keep their
 * attribution link.
 */
export function getJobSourceInfo(source: string): JobSourceInfo {
  switch (source) {
    case "user":
      return {
        label: "Community",
        kind: "community",
        description: "Shared by a Kalify user",
        attribution: null,
        applyLabel: "View original posting",
      };
    case "themuse":
      return {
        label: "The Muse",
        kind: "external",
        description: "Listing from The Muse",
        attribution: { text: "The Muse", href: "https://www.themuse.com" },
        applyLabel: "Apply on The Muse",
      };
    case "greenhouse":
      return {
        label: "Employer posting",
        kind: "external",
        description: "From the company's careers site (via Greenhouse)",
        attribution: null,
        applyLabel: "Apply on company site",
      };
    case "lever":
      return {
        label: "Employer posting",
        kind: "external",
        description: "From the company's careers site (via Lever)",
        attribution: null,
        applyLabel: "Apply on company site",
      };
    default:
      return {
        label: "External",
        kind: "external",
        description: "Listing from an external job board",
        attribution: null,
        applyLabel: "View original posting",
      };
  }
}

/**
 * Returns the URL only if it's an absolute `http(s)` URL. Server-side
 * validation already enforces this for submissions; this is a second check
 * so a `javascript:` or otherwise odd value can never become an `href`.
 */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.trim().length === 0) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/** Host name for display next to an outbound link, without a leading "www.". */
export function displayHost(url: string | null | undefined): string | null {
  const safe = safeExternalUrl(url);
  if (!safe) return null;
  return new URL(safe).hostname.replace(/^www\./, "");
}
