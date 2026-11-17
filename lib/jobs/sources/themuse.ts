/**
 * The Muse adapter (docs/ARCHITECTURE.md §13.6.2): the v1
 * `lib/jobs/themuse.ts` refactored behind `JobSourceAdapter`. Same mapping,
 * same newest-first sort; `MAX_PAGES_PER_LEVEL` moved to
 * `job_sources.config.max_pages_per_level` (seeded 5 in 0009).
 *
 * Public Jobs API v1, unauthenticated (500 req/hour). Listings are tagged
 * with an explicit `levels` taxonomy, so the level filter happens at the
 * source and the student title filter is skipped (§13.6.3).
 *
 * Terms-of-use obligation: every listing we display must link back to its
 * themuse.com page (https://www.themuse.com/developers/api/v2/terms). The
 * mapper always sets `sourceUrl` to `refs.landing_page`; a result without
 * one maps to an empty `sourceUrl` and the sync drops it as invalid.
 *
 * Field map (raw → NormalizedListing):
 *   id                    → externalId (string)
 *   name                  → title (trimmed, capped)
 *   company.name          → company (trimmed, capped, null if empty)
 *   contents (HTML)       → descriptionText (stripHtml, capped)
 *   refs.landing_page     → sourceUrl
 *   locations[].name      → locationText (joined ", "); primaryLocation /
 *                           locationCountry / remoteType derived from that
 *                           text by `themuseLocationFromText`
 *   levels[0].name        → levelRaw
 *   publication_date      → postedAt
 *   categories[0].name    → sourceMetadata.category
 *
 * Cursor: `${levelIndex}:${page}` into `config.levels`. Pages run 0..N per
 * level, up to `max_pages_per_level` or the API's `page_count`, then move to
 * the next level. `complete` is true once the last page of the last level
 * has been fetched (an incremental source has no snapshot semantics).
 */

import { z } from "zod";

import { stripHtml } from "@/lib/jobs/html";
import type { PrimaryLocation } from "@/lib/jobs/normalize";
import { SOURCE_DISPLAY } from "@/lib/jobs/sources/display";
import { fetchSourceJson, SourceHttpError } from "@/lib/jobs/sources/http";
import {
  SourceConfigError,
  SourceCursorError,
  type FetchPageResult,
  type JobSourceAdapter,
  type NormalizedListing,
} from "@/lib/jobs/sources/types";
import {
  JOB_DESCRIPTION_COMPANY_MAX_LENGTH,
  JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_LOCATION_MAX_LENGTH,
  JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH,
  JOB_DESCRIPTION_TITLE_MAX_LENGTH,
} from "@/lib/validation/schemas";

export const THEMUSE_API_BASE = "https://www.themuse.com/api/public/jobs";

/** Defaults used when `job_sources.config` omits a field (same values as the 0009 seed). */
export const THEMUSE_DEFAULT_LEVELS = ["Internship", "Entry Level"] as const;
export const THEMUSE_DEFAULT_MAX_PAGES_PER_LEVEL = 5;

export const themuseConfigSchema = z.object({
  levels: z.array(z.string().min(1).max(100)).min(1).max(10).default([...THEMUSE_DEFAULT_LEVELS]),
  max_pages_per_level: z.int().min(1).max(50).default(THEMUSE_DEFAULT_MAX_PAGES_PER_LEVEL),
});

export type ThemuseConfig = z.output<typeof themuseConfigSchema>;

export function parseThemuseConfig(config: unknown): ThemuseConfig {
  const parsed = themuseConfigSchema.safeParse(config ?? {});
  if (!parsed.success) {
    throw new SourceConfigError("job_sources.config for themuse is invalid.");
  }
  return parsed.data;
}

type Cursor = { levelIndex: number; page: number };

const CURSOR_PATTERN = /^(\d{1,2}):(\d{1,3})$/;

export function encodeThemuseCursor(cursor: Cursor): string {
  return `${cursor.levelIndex}:${cursor.page}`;
}

export function decodeThemuseCursor(raw: string | null, config: ThemuseConfig): Cursor {
  if (raw === null) return { levelIndex: 0, page: 0 };
  const match = CURSOR_PATTERN.exec(raw);
  if (!match) throw new SourceCursorError("Malformed The Muse cursor.");
  const cursor = { levelIndex: Number(match[1]), page: Number(match[2]) };
  if (cursor.levelIndex >= config.levels.length || cursor.page >= config.max_pages_per_level) {
    throw new SourceCursorError("The Muse cursor is out of range for the current config.");
  }
  return cursor;
}

// ---------------------------------------------------------------------
// Raw payload (only the fields we read; everything else is ignored)
// ---------------------------------------------------------------------

const nameObject = z.object({ name: z.string().nullish() }).passthrough();

const rawJobSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    name: z.string().nullish(),
    contents: z.string().nullish(),
    company: nameObject.nullish(),
    locations: z.array(nameObject).nullish(),
    levels: z.array(nameObject).nullish(),
    categories: z.array(nameObject).nullish(),
    publication_date: z.string().nullish(),
    refs: z.object({ landing_page: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

export type RawThemuseJob = z.input<typeof rawJobSchema>;

const rawResponseSchema = z
  .object({
    page: z.number().optional(),
    page_count: z.number().int().nonnegative(),
    results: z.array(z.unknown()).nullish(),
  })
  .passthrough();

// ---------------------------------------------------------------------
// Location parsing (shared with maintenance.backfill_job_keys)
// ---------------------------------------------------------------------

const US_STATE_CODES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR".split(
    " ",
  ),
);

const COUNTRY_NAME_TO_ISO: Readonly<Record<string, string>> = {
  "united states": "US",
  usa: "US",
  us: "US",
  "united kingdom": "GB",
  uk: "GB",
  canada: "CA",
  ireland: "IE",
  germany: "DE",
  france: "FR",
  india: "IN",
  australia: "AU",
  netherlands: "NL",
  spain: "ES",
  singapore: "SG",
};

const REMOTE_PATTERN = /\b(remote|flexible)\b/i;

/**
 * Derives the dedupe location fields from The Muse's display location text
 * (the `", "`-joined `locations[].name`). Used by the adapter on fresh
 * results and by `maintenance.backfill_job_keys` on stored
 * `job_descriptions.location`, so both produce the same dedupe key.
 *
 * - Any mention of "Remote"/"Flexible" (Muse's "Flexible / Remote") → remote.
 * - Otherwise the first two comma-separated parts: "City, ST" (US state
 *   code → region ST, country US) or "City, Country".
 */
export function themuseLocationFromText(text: string | null): {
  remoteType: "remote" | null;
  primaryLocation: PrimaryLocation | null;
  locationCountry: string | null;
} {
  if (!text || text.trim() === "") {
    return { remoteType: null, primaryLocation: null, locationCountry: null };
  }
  if (REMOTE_PATTERN.test(text)) {
    return { remoteType: "remote", primaryLocation: null, locationCountry: null };
  }
  const [cityPart, secondPart] = text.split(",").map((part) => part.trim());
  const city = cityPart || null;
  if (!secondPart) {
    return { remoteType: null, primaryLocation: { city, region: null, country: null }, locationCountry: null };
  }
  if (US_STATE_CODES.has(secondPart.toUpperCase()) && secondPart.length === 2) {
    return {
      remoteType: null,
      primaryLocation: { city, region: secondPart.toUpperCase(), country: "US" },
      locationCountry: "US",
    };
  }
  const iso = COUNTRY_NAME_TO_ISO[secondPart.toLowerCase()] ?? null;
  return {
    remoteType: null,
    primaryLocation: { city, region: null, country: iso ?? secondPart },
    locationCountry: iso,
  };
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
}

/**
 * Maps one raw result. Returns null only when the result isn't even
 * object-shaped with an id; missing title/description/landing page map to
 * empty strings and are dropped (and counted) by the sync's validation.
 */
export function mapThemuseJob(raw: unknown): NormalizedListing | null {
  const parsed = rawJobSchema.safeParse(raw);
  if (!parsed.success) return null;
  const job = parsed.data;

  const locationText =
    (job.locations ?? [])
      .map((loc) => loc.name?.trim())
      .filter((name): name is string => Boolean(name))
      .join(", ")
      .slice(0, JOB_DESCRIPTION_LOCATION_MAX_LENGTH) || null;
  const location = themuseLocationFromText(locationText);
  const category = job.categories?.[0]?.name?.trim();

  return {
    externalId: String(job.id),
    title: (job.name ?? "").trim().slice(0, JOB_DESCRIPTION_TITLE_MAX_LENGTH),
    company: job.company?.name?.trim().slice(0, JOB_DESCRIPTION_COMPANY_MAX_LENGTH) || null,
    descriptionText: job.contents ? stripHtml(job.contents).slice(0, JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH) : "",
    sourceUrl: (job.refs?.landing_page ?? "").trim().slice(0, JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH),
    applyUrl: null,
    locationText,
    primaryLocation: location.primaryLocation,
    locationCountry: location.locationCountry,
    remoteType: location.remoteType,
    employmentType: null,
    levelRaw: job.levels?.[0]?.name?.trim() || null,
    postedAt: isoOrNull(job.publication_date),
    sourceExpiresAt: null,
    salary: null,
    sourceBoard: null,
    sourceMetadata: category ? { category: category.slice(0, 100) } : {},
  };
}

export interface ThemuseAdapterDeps {
  fetchImpl?: typeof fetch;
}

export function createThemuseAdapter(deps: ThemuseAdapterDeps = {}): JobSourceAdapter {
  return {
    slug: "themuse",
    displayName: SOURCE_DISPLAY.themuse.displayName,
    syncMode: "incremental",
    requiredEnv: [],
    // 500 req/hour unauthenticated; a daily run makes ~10 requests.
    minRequestIntervalMs: 1_000,
    attribution: SOURCE_DISPLAY.themuse.attribution,

    async fetchPage({ cursor, config, signal }): Promise<FetchPageResult> {
      const cfg = parseThemuseConfig(config);
      const { levelIndex, page } = decodeThemuseCursor(cursor, cfg);
      const level = cfg.levels[levelIndex];

      // sort=publication_date&descending=true matters: without it the API
      // returns a fixed sample, and a daily sync would re-fetch the same
      // listings forever instead of picking up new ones.
      const url = new URL(THEMUSE_API_BASE);
      url.searchParams.set("level", level);
      url.searchParams.set("page", String(page));
      url.searchParams.set("sort", "publication_date");
      url.searchParams.set("descending", "true");

      const body = rawResponseSchema.safeParse(
        await fetchSourceJson(url, { signal, fetchImpl: deps.fetchImpl }),
      );
      if (!body.success) {
        throw new SourceHttpError(`${url.host} returned an unexpected response shape.`, 200, null);
      }

      const listings = (body.data.results ?? [])
        .map(mapThemuseJob)
        .filter((listing): listing is NormalizedListing => listing !== null);

      const lastPageOfLevel = page + 1 >= Math.min(body.data.page_count, cfg.max_pages_per_level);
      let next: Cursor | null;
      if (!lastPageOfLevel) next = { levelIndex, page: page + 1 };
      else if (levelIndex + 1 < cfg.levels.length) next = { levelIndex: levelIndex + 1, page: 0 };
      else next = null;

      return {
        listings,
        nextCursor: next ? encodeThemuseCursor(next) : null,
        complete: next === null,
      };
    },
  };
}

export const themuseAdapter = createThemuseAdapter();
