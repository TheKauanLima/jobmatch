/**
 * Client for The Muse's public Jobs API (v1, unauthenticated) — the external
 * source for the job-listing ingestion documented in docs/ARCHITECTURE.md
 * §7. Chosen over alternatives (Adzuna, USAJOBS, etc.) specifically because
 * it requires no signup/API key for read access (500 req/hour unauthenticated,
 * confirmed against the live API and https://www.themuse.com/developers/api/v2/terms
 * at the time this was written) and tags listings with an explicit
 * `levels` taxonomy that includes "Internship" and "Entry Level" — exactly
 * the segment `lib/jobs/sync.ts` targets for a student audience, without
 * needing our own classifier.
 *
 * Terms-of-use obligation this module exists to satisfy: every listing we
 * display must link back to its original themuse.com page (see
 * https://www.themuse.com/developers/api/v2/terms — "Muse Content ... will
 * link back to The Muse Website"). `mapThemuseJobToExternalJobDescription`
 * always sets `sourceUrl` to `refs.landing_page` for exactly this reason —
 * do not drop or make optional.
 */

import {
  JOB_DESCRIPTION_COMPANY_MAX_LENGTH,
  JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_TITLE_MAX_LENGTH,
} from "@/lib/validation/schemas";

const THEMUSE_API_BASE = "https://www.themuse.com/api/public/jobs";

/** Levels (The Muse's own vocabulary) this integration ingests — see module docstring. */
export const THEMUSE_SYNC_LEVELS = ["Internship", "Entry Level"] as const;
export type ThemuseSyncLevel = (typeof THEMUSE_SYNC_LEVELS)[number];

// Mirrors the fields of The Muse's job-result shape that this module
// actually reads. The real payload has many more fields (tags, contributed
// perks, etc.) we don't use — deliberately not modeled here.
type RawThemuseJob = {
  id: number;
  name?: string | null;
  contents?: string | null;
  company?: { name?: string | null } | null;
  locations?: { name?: string | null }[] | null;
  levels?: { name?: string | null }[] | null;
  publication_date?: string | null;
  refs?: { landing_page?: string | null } | null;
};

type RawThemuseResponse = {
  page: number;
  page_count: number;
  results?: RawThemuseJob[] | null;
};

/** Thrown when a request to The Muse's API fails (network error or non-2xx status). */
export class ThemuseApiError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ThemuseApiError";
  }
}

/**
 * Strips HTML tags from The Muse's `contents` field (rich-text job
 * descriptions) down to plain text, since `job_descriptions.description` is
 * a plain-text column fed directly into the Claude matching prompt (per
 * docs/ARCHITECTURE.md §2) — raw markup would waste tokens and add no
 * signal. Deliberately a small regex-based stripper rather than a new
 * dependency (e.g. `cheerio`/`sanitize-html`): the input is a closed,
 * moderately well-formed HTML fragment from a single known API, not
 * arbitrary hostile markup that needs a real parser to handle safely.
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

/**
 * Fetches one page of The Muse's public jobs listing, filtered to a single
 * `level`, sorted newest-first (`sort=publication_date&descending=true`).
 * The sort matters more than it might look: confirmed against the live API
 * that omitting it returns a fixed, deterministic (not date-ordered) sample
 * that's identical across repeated calls — a daily cron without this sort
 * would keep re-fetching the same ~`MAX_PAGES_PER_LEVEL` pages' worth of
 * listings forever instead of accumulating new ones over time, defeating
 * the point of a recurring sync. With it, each run surfaces whatever's newly
 * posted since the last one, so the board's distinct-listing coverage grows
 * day over day instead of plateauing at one run's page size.
 *
 * The API paginates 20 results/page (`items_per_page`, not
 * caller-configurable) and reports `page_count` (total pages available for
 * this filter) — callers use that to know when to stop paginating.
 */
export async function fetchThemuseJobsPage(
  level: ThemuseSyncLevel,
  page: number,
): Promise<{ results: RawThemuseJob[]; pageCount: number }> {
  const url = new URL(THEMUSE_API_BASE);
  url.searchParams.set("level", level);
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", "publication_date");
  url.searchParams.set("descending", "true");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": "JobMatch/1.0 (+https://github.com)" },
    });
  } catch (err) {
    throw new ThemuseApiError(
      `Network error fetching The Muse jobs (level=${level}, page=${page})`,
      err,
    );
  }

  if (!response.ok) {
    throw new ThemuseApiError(
      `The Muse API returned ${response.status} for level=${level}, page=${page}`,
    );
  }

  const body = (await response.json()) as RawThemuseResponse;
  return { results: body.results ?? [], pageCount: body.page_count };
}

/**
 * Maps one raw Muse job result to the shape `upsertExternalJobDescriptions`
 * expects. Returns `null` for a listing missing a required field (`name` or
 * `contents`) — The Muse's schema doesn't formally guarantee either is
 * present, and a job with no title or description text isn't useful for
 * matching; callers filter these out rather than inserting a broken row.
 *
 * Field lengths are clamped to the same caps `lib/validation/schemas.ts`
 * enforces for user-submitted job descriptions (`JOB_DESCRIPTION_*_MAX_LENGTH`)
 * so a long external listing can't produce a row wider than the app already
 * assumes elsewhere (e.g. the Claude matching prompt's token-cost ceiling).
 */
export function mapThemuseJobToExternalJobDescription(
  raw: RawThemuseJob,
): {
  externalId: string;
  title: string;
  company: string | null;
  description: string;
  sourceUrl: string | null;
  level: string | null;
  location: string | null;
  postedAt: string | null;
} | null {
  const title = raw.name?.trim();
  const description = raw.contents ? stripHtml(raw.contents) : "";

  if (!title || !description) {
    return null;
  }

  return {
    externalId: String(raw.id),
    title: title.slice(0, JOB_DESCRIPTION_TITLE_MAX_LENGTH),
    company:
      raw.company?.name?.trim().slice(0, JOB_DESCRIPTION_COMPANY_MAX_LENGTH) ||
      null,
    description: description.slice(0, JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH),
    sourceUrl: raw.refs?.landing_page ?? null,
    level: raw.levels?.[0]?.name ?? null,
    location:
      raw.locations
        ?.map((loc) => loc.name)
        .filter((name): name is string => Boolean(name))
        .join(", ") || null,
    postedAt: raw.publication_date ?? null,
  };
}
