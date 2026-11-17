/**
 * Job-source adapter interface (docs/ARCHITECTURE.md §13.6.2). Every
 * external source is one adapter behind this interface; the generic
 * `lib/jobs/sync.ts` drives it (paging, throttling, filtering, upserts,
 * dedupe, run records). Adapters only fetch and map.
 */

import type { JobSourceSlug } from "@/types/database";

export type { JobSourceSlug };

export type NormalizedListing = {
  /** Stable per source. Board sources prefix the board: `${board}:${id}`. */
  externalId: string;
  title: string;
  company: string | null;
  /** Plain text, already HTML-stripped, capped to JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH. */
  descriptionText: string;
  /** Canonical posting page (attribution / link-back). */
  sourceUrl: string;
  applyUrl: string | null;
  /** Display string. */
  locationText: string | null;
  primaryLocation: { city: string | null; region: string | null; country: string | null } | null;
  /** ISO alpha-2. */
  locationCountry: string | null;
  remoteType: "onsite" | "hybrid" | "remote" | null;
  employmentType: string | null;
  /** Source vocabulary → job_descriptions.level (display/filter). */
  levelRaw: string | null;
  /** ISO. */
  postedAt: string | null;
  /** ISO, e.g. USAJOBS ApplicationCloseDate. */
  sourceExpiresAt: string | null;
  salary: {
    min: number | null;
    max: number | null;
    currency: string | null;
    period: "hour" | "year" | "month" | null;
  } | null;
  sourceBoard: string | null;
  sourceMetadata: Record<string, string | number | boolean | null>;
};

export type FetchPageResult = {
  listings: NormalizedListing[];
  nextCursor: string | null;
  complete: boolean;
};

export interface JobSourceAdapter {
  slug: JobSourceSlug;
  displayName: string;
  syncMode: "snapshot" | "incremental";
  /** Adapter disabled (logged) if any is missing. */
  requiredEnv: string[];
  /** Politeness throttle between requests. */
  minRequestIntervalMs: number;
  /** Rendered on job cards/detail. */
  attribution: { text: string; url: string } | null;
  /** board: null for non-board sources. cursor: null = first page. */
  fetchPage(args: {
    board: string | null;
    cursor: string | null;
    config: unknown;
    signal: AbortSignal;
  }): Promise<FetchPageResult>;
}

/**
 * Thrown by an adapter when it is handed a cursor it didn't produce (e.g. a
 * hand-edited task payload). Not retryable: the same cursor fails again.
 */
export class SourceCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceCursorError";
  }
}

/**
 * Thrown by an adapter whose `job_sources.config` doesn't parse. Not
 * retryable until an operator fixes the row.
 */
export class SourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceConfigError";
  }
}
