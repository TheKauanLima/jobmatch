/**
 * Lever public Postings API client and mapper (docs/ARCHITECTURE.md §7.7.1,
 * §7.7.4). No auth. One GET returns every open posting for a company as a
 * top-level JSON array, a snapshot:
 *
 *   GET https://api.lever.co/v0/postings/{token}?mode=json
 *
 * US-hosted sites only (EU sites live on api.eu.lever.co, out of scope).
 * Observed live on 2026-11-20 (fixture: tests/fixtures/sources/lever-board.json):
 * every posting includes `createdAt` (epoch ms) and `country` (ISO alpha-2),
 * and an unknown token returns 404.
 */

import {
  JOB_DESCRIPTION_COMPANY_MAX_LENGTH,
  JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_LOCATION_MAX_LENGTH,
  JOB_DESCRIPTION_TITLE_MAX_LENGTH,
} from "@/lib/validation/schemas";
import type { ExternalJobDescriptionUpsert } from "@/lib/supabase/queries/jobDescriptions";
import { deriveJobFacets } from "@/lib/jobs/facets";
import { stripHtml } from "@/lib/jobs/html";
import { classifyStudentLevel, isUsLocation } from "@/lib/jobs/studentFilter";
import type { JobBoardCompany } from "@/lib/jobs/sources/companies";
import {
  boardExternalId,
  clampText,
  fetchBoardJson,
  httpUrlOrNull,
  isoDateOrNull,
  JobBoardFetchError,
} from "@/lib/jobs/sources/common";

const LEVER_API_BASE = "https://api.lever.co/v0/postings";

/**
 * The fields of a Lever posting this module reads. Everything is
 * optional/unknown-typed because the payload is external; the mapper checks
 * each field. (The real payload has more fields, unused.)
 */
export type RawLeverPosting = {
  id?: unknown;
  text?: unknown;
  categories?: {
    location?: unknown;
    allLocations?: unknown;
    /** Feed the field classifier only (§7.8.3). */
    department?: unknown;
    team?: unknown;
  } | null;
  /** "onsite" | "hybrid" | "remote" | "unspecified"; "remote" is a remote hint (§7.8.4). */
  workplaceType?: unknown;
  country?: unknown;
  descriptionPlain?: unknown;
  lists?: unknown;
  additionalPlain?: unknown;
  hostedUrl?: unknown;
  createdAt?: unknown;
};

/**
 * Fetches a company's whole Lever board. Throws `JobBoardFetchError` (with
 * `status` 404 for an unknown token) on any failure, including a body that
 * isn't an array.
 */
export async function fetchLeverBoard(
  token: string,
  signal?: AbortSignal,
): Promise<RawLeverPosting[]> {
  const body = await fetchBoardJson(
    "lever",
    token,
    `${LEVER_API_BASE}/${encodeURIComponent(token)}?mode=json`,
    signal,
  );

  if (!Array.isArray(body)) {
    throw new JobBoardFetchError("lever", token, null, "invalid_body");
  }
  return body.filter(
    (posting): posting is RawLeverPosting =>
      posting !== null && typeof posting === "object",
  );
}

/** `${token}:${id}` for any posting on the board (used for the unfiltered id set). */
export function leverExternalId(
  raw: RawLeverPosting,
  company: JobBoardCompany,
): string | null {
  return boardExternalId(company.token, raw.id);
}

function leverLocation(raw: RawLeverPosting): string | null {
  const all = raw.categories?.allLocations;
  if (Array.isArray(all)) {
    const joined = all
      .filter((loc): loc is string => typeof loc === "string")
      .map((loc) => loc.trim())
      .filter(Boolean)
      .join(", ");
    if (joined) return clampText(joined, JOB_DESCRIPTION_LOCATION_MAX_LENGTH);
  }
  return clampText(raw.categories?.location, JOB_DESCRIPTION_LOCATION_MAX_LENGTH);
}

/**
 * `descriptionPlain`, then each list as its `text` heading followed by
 * `stripHtml(content)`, then `additionalPlain`, joined by blank lines.
 */
function leverDescription(raw: RawLeverPosting): string | null {
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  };

  push(raw.descriptionPlain);
  if (Array.isArray(raw.lists)) {
    for (const list of raw.lists) {
      if (list === null || typeof list !== "object") continue;
      const { text, content } = list as { text?: unknown; content?: unknown };
      const heading = typeof text === "string" ? text.trim() : "";
      const body = typeof content === "string" ? stripHtml(content) : "";
      push([heading, body].filter(Boolean).join("\n"));
    }
  }
  push(raw.additionalPlain);

  return clampText(parts.join("\n\n"), JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH);
}

/** `categories.department` and `categories.team` joined with " / " (§7.8.3), or null. */
function leverDepartment(raw: RawLeverPosting): string | null {
  const parts = [raw.categories?.department, raw.categories?.team]
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : null;
}

/**
 * Maps one Lever posting to the upsert shape, or `null` when it has no id,
 * title, description, or http(s) posting URL, or when the student or US
 * filter rejects it (§7.7.3; Lever's `country`, when present, decides the
 * US check on its own). `company` comes from `displayName`. All fields are
 * clamped to `JOB_DESCRIPTION_*_MAX_LENGTH`. Board facets (§7.8.4) come from
 * the title, department/team, location, and `workplaceType === "remote"`.
 */
export function mapLeverJob(
  raw: RawLeverPosting,
  company: JobBoardCompany,
): ExternalJobDescriptionUpsert | null {
  const externalId = leverExternalId(raw, company);
  const title = clampText(raw.text, JOB_DESCRIPTION_TITLE_MAX_LENGTH);
  const sourceUrl = httpUrlOrNull(raw.hostedUrl);
  if (!externalId || !title || !sourceUrl) return null;

  const level = classifyStudentLevel(title);
  if (!level) return null;

  const location = leverLocation(raw);
  const country = typeof raw.country === "string" ? raw.country : null;
  if (!isUsLocation(location, country)) return null;

  const description = leverDescription(raw);
  if (!description) return null;

  return {
    externalId,
    title,
    company: clampText(company.displayName, JOB_DESCRIPTION_COMPANY_MAX_LENGTH),
    description,
    sourceUrl,
    level,
    location,
    postedAt:
      typeof raw.createdAt === "number" ? isoDateOrNull(raw.createdAt) : null,
    ...deriveJobFacets({
      title,
      location,
      department: leverDepartment(raw),
      remoteHint: raw.workplaceType === "remote",
    }),
  };
}
