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

// Both modules are import-free constants, safe for the client bundle (§7.8.7).
import {
  isJobCategory,
  JOB_CATEGORIES,
  jobCategoryLabel,
  type JobCategory,
} from "@/lib/jobs/categories";
import {
  isUsStateCode,
  US_STATE_CODES,
  US_STATES,
  usStateName,
  type UsStateCode,
} from "@/lib/jobs/usStates";

// ---------------------------------------------------------------------
// URL state: /jobs?q=&level=&category=&location=&sort=
// (docs/ARCHITECTURE.md §7.8.7)
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

/** Location filter: remote-only, or one US state/DC code (§7.8.1 #2). */
export type JobLocationFilter = "remote" | UsStateCode;

/**
 * Only the non-default sort is ever stored: "recent" with a search term.
 * Without `q` the board is always newest first; with `q` the default is
 * "Best match" (relevance), represented as `null`.
 */
export type JobSortFilter = "recent";

export type JobsBoardQuery = {
  q: string | null;
  level: JobLevelFilter | null;
  category: JobCategory | null;
  location: JobLocationFilter | null;
  sort: JobSortFilter | null;
};

/** The board's filters: everything in the URL except `q` and `sort`. */
export type JobsFilterKey = "level" | "category" | "location";

/** A query with nothing applied. */
export const EMPTY_JOBS_QUERY: JobsBoardQuery = {
  q: null,
  level: null,
  category: null,
  location: null,
  sort: null,
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
 * Normalizes a raw `location` value: "remote" (any case) or a US state/DC
 * code (any case, returned uppercase). Anything else is `null`.
 */
export function parseJobLocationFilter(value: unknown): JobLocationFilter | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "remote") return "remote";
  const code = trimmed.toUpperCase();
  return isUsStateCode(code) ? code : null;
}

/** Display label for a location filter: "Remote" or the state's name. */
export function jobLocationLabel(location: JobLocationFilter): string {
  return location === "remote" ? "Remote" : (usStateName(location) ?? location);
}

/**
 * Parses `/jobs` search params into the board's query state. Lenient by
 * design (§7.8.7): unknown/invalid values are dropped rather than shown as
 * an error, blank searches become `null`, over-long searches are clamped to
 * what the API accepts, `location` is normalized, and `sort` survives only
 * as "recent" alongside a search term (the only non-default case).
 */
export function parseJobsSearchParams(params: RawSearchParams): JobsBoardQuery {
  const rawQ = firstValue(params.q)?.trim() ?? "";
  const q = rawQ ? rawQ.slice(0, JOBS_SEARCH_MAX_LENGTH).trim() : null;
  const rawLevel = firstValue(params.level);
  const rawCategory = firstValue(params.category)?.trim() ?? "";
  const rawSort = firstValue(params.sort)?.trim();
  return {
    q,
    level: isJobLevelFilter(rawLevel) ? rawLevel : null,
    category: isJobCategory(rawCategory) ? rawCategory : null,
    location: parseJobLocationFilter(firstValue(params.location)),
    sort: q && rawSort === "recent" ? "recent" : null,
  };
}

function setQueryParams(
  params: URLSearchParams,
  query: Partial<JobsBoardQuery>,
): void {
  const q = query.q?.trim();
  if (q) params.set("q", q);
  if (query.level) params.set("level", query.level);
  if (query.category) params.set("category", query.category);
  if (query.location) params.set("location", query.location);
  // "Best match" is the default with a search, and there's no sort without one.
  if (q && query.sort === "recent") params.set("sort", "recent");
}

/**
 * Builds a `/jobs` href for the given state. Only non-default values are
 * written: empty values are dropped, and `sort` is dropped without `q`.
 */
export function buildJobsHref(query: Partial<JobsBoardQuery> = {}): string {
  const params = new URLSearchParams();
  setQueryParams(params, query);
  const search = params.toString();
  return search ? `/jobs?${search}` : "/jobs";
}

/**
 * Returns `query` with one URL param replaced by a raw value from a control
 * (a `<select>`'s `value`; `""` means "any"). The result goes back through
 * `parseJobsSearchParams`, so an unexpected value is dropped, never sent.
 */
export function withJobsParam(
  query: JobsBoardQuery,
  key: JobsFilterKey | "sort",
  value: string,
): JobsBoardQuery {
  return parseJobsSearchParams({
    q: query.q ?? undefined,
    level: query.level ?? undefined,
    category: query.category ?? undefined,
    location: query.location ?? undefined,
    sort: query.sort ?? undefined,
    [key]: value,
  });
}

/** True when a search term or any filter is applied. */
export function hasActiveJobsQuery(query: JobsBoardQuery): boolean {
  return Boolean(query.q || query.level || query.category || query.location);
}

/** Stable key for one search/filter combination (remounts paginated lists). */
export function jobsQueryKey(query: JobsBoardQuery): string {
  // `q` goes last: it's free text and may itself contain the separator.
  return [
    query.level ?? "all",
    query.category ?? "all",
    query.location ?? "any",
    query.q && query.sort === "recent" ? "recent" : "default",
    query.q ?? "",
  ].join(":");
}

/** Builds the `GET /api/job-descriptions` path for a page of results. */
export function buildJobsApiPath(
  query: JobsBoardQuery,
  cursor: string | null = null,
): string {
  const params = new URLSearchParams();
  setQueryParams(params, query);
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  return search ? `/api/job-descriptions?${search}` : "/api/job-descriptions";
}

/**
 * Result-count line, e.g. "20+ internship jobs · Data & AI · Remote ·
 * Newest first". The API has no total count (it fetches `limit + 1` to know
 * whether another page exists), so when more pages remain the count is shown
 * as "20+" rather than implying it's the total. The order is named whenever
 * it's by date (always without a search, or with "Most recent" chosen), so
 * the list's order is never a guess.
 */
export function formatResultSummary(
  input: { count: number; hasMore: boolean } & JobsBoardQuery,
): string {
  const { count, hasMore, q, level, category, location, sort } = input;
  const amount = hasMore ? `${count}+` : String(count);
  const noun = count === 1 && !hasMore ? "job" : "jobs";
  const levelPart = level ? ` ${level.toLowerCase()}` : "";
  const searchPart = q ? ` matching “${q}”` : "";
  const parts = [`${amount}${levelPart} ${noun}${searchPart}`];
  const fieldLabel = jobCategoryLabel(category);
  if (fieldLabel) parts.push(fieldLabel);
  if (location) parts.push(jobLocationLabel(location));
  if (!q || sort === "recent") parts.push("Newest first");
  return parts.join(" · ");
}

// ---------------------------------------------------------------------
// Filter options (Field / Location / Sort selects)
// ---------------------------------------------------------------------

/**
 * `GET /api/job-descriptions/facets` (§7.8.6): global counts over all active
 * listings, independent of the other filters. Zero counts are absent. Used
 * only to avoid dead ends; no numbers are shown (§7.8.1 #5).
 */
export type JobsFacets = {
  categories: Partial<Record<JobCategory, number>>;
  states: Partial<Record<UsStateCode, number>>;
  remote: number;
};

function positiveCounts<K extends string>(
  value: object,
  isKey: (key: string) => key is K,
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const [key, count] of Object.entries(value)) {
    if (isKey(key) && typeof count === "number" && Number.isFinite(count) && count > 0) {
      out[key] = count;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a facets response body, keeping only known slugs/codes with
 * positive counts. Returns `null` for anything that isn't the documented
 * shape, which the board treats exactly like a failed request.
 */
export function parseJobsFacets(body: unknown): JobsFacets | null {
  if (!isPlainObject(body)) return null;
  const record = body as Record<string, unknown>;
  if (!isPlainObject(record.categories) || !isPlainObject(record.states)) {
    return null;
  }
  return {
    categories: positiveCounts(record.categories, isJobCategory),
    states: positiveCounts(record.states, isUsStateCode),
    remote:
      typeof record.remote === "number" && Number.isFinite(record.remote)
        ? Math.max(0, record.remote)
        : 0,
  };
}

export type JobsSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export const NO_LISTINGS_SUFFIX = " (no listings yet)";

/**
 * Field select options: "All fields", then every category in list order.
 * With facets, a field with no listings stays listed but disabled, labelled
 * " (no listings yet)", so the list is stable and the user can see the
 * field exists. The selected field is never disabled, so a deep link still
 * shows what's applied. Without facets (`null`: the request failed) every
 * field is enabled.
 */
export function buildFieldOptions(
  facets: JobsFacets | null,
  selected: JobCategory | null,
): JobsSelectOption[] {
  return [
    { value: "", label: "All fields" },
    ...JOB_CATEGORIES.map(({ slug, label }) => {
      const empty = facets !== null && !facets.categories[slug];
      return {
        value: slug,
        label: empty ? `${label}${NO_LISTINGS_SUFFIX}` : label,
        disabled: empty && slug !== selected,
      };
    }),
  ];
}

/**
 * Location select options: "Any location", "Remote", then the states that
 * have at least one listing, sorted by name. A selected state with no
 * listings (deep link) is still offered, so the select reflects the URL.
 * Without facets only "Any location" and "Remote" are offered (plus a
 * selected state); filtering itself still works.
 */
export function buildLocationOptions(
  facets: JobsFacets | null,
  selected: JobLocationFilter | null,
): JobsSelectOption[] {
  const codes = new Set<UsStateCode>(
    facets ? US_STATE_CODES.filter((code) => (facets.states[code] ?? 0) > 0) : [],
  );
  if (selected && selected !== "remote") codes.add(selected);
  const states = [...codes]
    .map((code) => ({ value: code, label: US_STATES[code] as string }))
    .sort((a, b) => a.label.localeCompare(b.label, "en-US"));
  return [
    { value: "", label: "Any location" },
    { value: "remote", label: "Remote" },
    ...states,
  ];
}

/** Sort select options, offered only while a search term is applied. */
export const JOBS_SORT_OPTIONS: readonly JobsSelectOption[] = [
  { value: "relevance", label: "Best match" },
  { value: "recent", label: "Most recent" },
];

// ---------------------------------------------------------------------
// Active-filter chips (empty state)
// ---------------------------------------------------------------------

export type ActiveJobsFilter = {
  key: "q" | JobsFilterKey;
  /** e.g. "Field" */
  name: string;
  /** e.g. "Data & AI" */
  value: string;
  /** `/jobs` href with just this param removed. */
  removeHref: string;
};

/**
 * One entry per applied search/filter, in URL order, each with a link that
 * drops only that param (removing the search also drops `sort`).
 */
export function listActiveJobsFilters(query: JobsBoardQuery): ActiveJobsFilter[] {
  const filters: ActiveJobsFilter[] = [];
  if (query.q) {
    filters.push({
      key: "q",
      name: "Search",
      value: `“${query.q}”`,
      removeHref: buildJobsHref({ ...query, q: null }),
    });
  }
  if (query.level) {
    filters.push({
      key: "level",
      name: "Level",
      value: query.level,
      removeHref: buildJobsHref({ ...query, level: null }),
    });
  }
  if (query.category) {
    filters.push({
      key: "category",
      name: "Field",
      value: jobCategoryLabel(query.category) ?? query.category,
      removeHref: buildJobsHref({ ...query, category: null }),
    });
  }
  if (query.location) {
    filters.push({
      key: "location",
      name: "Location",
      value: jobLocationLabel(query.location),
      removeHref: buildJobsHref({ ...query, location: null }),
    });
  }
  return filters;
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
