/**
 * Greenhouse public Job Board API client and mapper (docs/ARCHITECTURE.md
 * §7.7.1, §7.7.4). No auth. One GET returns every open job on a company's
 * board, a snapshot:
 *
 *   GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 *
 * Observed live on 2026-11-20 (fixture: tests/fixtures/sources/greenhouse-board.json):
 * the list response includes `first_published` on every job, `content` is
 * entity-escaped HTML (`&lt;p&gt;…`), and an unknown token returns 404.
 */

import {
  JOB_DESCRIPTION_COMPANY_MAX_LENGTH,
  JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_LOCATION_MAX_LENGTH,
  JOB_DESCRIPTION_TITLE_MAX_LENGTH,
} from "@/lib/validation/schemas";
import type { ExternalJobDescriptionUpsert } from "@/lib/supabase/queries/jobDescriptions";
import { deriveJobFacets } from "@/lib/jobs/facets";
import { decodeHtmlEntities, stripHtml } from "@/lib/jobs/html";
import {
  classifyStudentLevel,
  hasNonUsSignal,
  hasUsSignal,
  isUsLocation,
} from "@/lib/jobs/studentFilter";
import type { JobBoardCompany } from "@/lib/jobs/sources/companies";
import {
  boardExternalId,
  clampText,
  fetchBoardJson,
  httpUrlOrNull,
  isoDateOrNull,
  JobBoardFetchError,
} from "@/lib/jobs/sources/common";

const GREENHOUSE_API_BASE = "https://boards-api.greenhouse.io/v1/boards";

/**
 * The fields of a Greenhouse list-response job this module reads. Everything
 * is optional/unknown-typed because the payload is external; the mapper
 * checks each field. (The real payload has many more fields, unused.)
 * `updated_at` is deliberately not read: it changes on every edit (§7.7.4).
 */
export type RawGreenhouseJob = {
  id?: unknown;
  title?: unknown;
  location?: { name?: unknown } | null;
  absolute_url?: unknown;
  content?: unknown;
  first_published?: unknown;
  /** e.g. `{ name: "Los Angeles, CA", location: "Los Angeles, California, United States" }`. */
  offices?: unknown;
  /** e.g. `[{ name: "Engineering" }]`; feeds the field classifier only (§7.8.3). */
  departments?: unknown;
};

/** `departments[].name` joined with " / " (§7.8.3), or null. */
function greenhouseDepartment(raw: RawGreenhouseJob): string | null {
  if (!Array.isArray(raw.departments)) return null;
  const names = raw.departments
    .map((department) =>
      department !== null && typeof department === "object"
        ? (department as { name?: unknown }).name
        : null,
    )
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? names.join(" / ") : null;
}

/**
 * US check for a Greenhouse job (§7.7.3, amended 2026-11-20):
 * 1. `location.name` passes `isUsLocation` → US.
 * 2. `location.name` names an explicit non-US place (`hasNonUsSignal`:
 *    "Vancouver, British Columbia, Canada", "Toronto", "Remote Canada") →
 *    not US, whatever the offices say (Greenhouse often attaches every
 *    company office to a posting).
 * 3. Otherwise `location.name` is placeless ("Hybrid", "In-Office",
 *    "San Francisco Bay Area", a bare US city) → US when any office's
 *    `location` or `name` has a *positive* US signal (`hasUsSignal`; blank
 *    or "Remote"-only office values don't count).
 */
function isGreenhouseJobUs(raw: RawGreenhouseJob, location: string | null): boolean {
  if (isUsLocation(location)) return true;
  if (hasNonUsSignal(location)) return false;
  if (!Array.isArray(raw.offices)) return false;
  return raw.offices.some((office) => {
    if (office === null || typeof office !== "object") return false;
    const { location: officeLocation, name } = office as {
      location?: unknown;
      name?: unknown;
    };
    return (
      (typeof officeLocation === "string" && hasUsSignal(officeLocation)) ||
      (typeof name === "string" && hasUsSignal(name))
    );
  });
}

/**
 * Fetches a company's whole Greenhouse board. Throws `JobBoardFetchError`
 * (with `status` 404 for an unknown token) on any failure, including a body
 * without a `jobs` array.
 */
export async function fetchGreenhouseBoard(
  token: string,
  signal?: AbortSignal,
): Promise<RawGreenhouseJob[]> {
  const body = await fetchBoardJson(
    "greenhouse",
    token,
    `${GREENHOUSE_API_BASE}/${encodeURIComponent(token)}/jobs?content=true`,
    signal,
  );

  const jobs =
    body !== null && typeof body === "object"
      ? (body as { jobs?: unknown }).jobs
      : undefined;
  if (!Array.isArray(jobs)) {
    throw new JobBoardFetchError("greenhouse", token, null, "invalid_body");
  }
  return jobs.filter(
    (job): job is RawGreenhouseJob => job !== null && typeof job === "object",
  );
}

/** `${token}:${id}` for any job on the board (used for the unfiltered id set). */
export function greenhouseExternalId(
  raw: RawGreenhouseJob,
  company: JobBoardCompany,
): string | null {
  return boardExternalId(company.token, raw.id);
}

/**
 * Maps one Greenhouse job to the upsert shape, or `null` when it has no id,
 * title, description, or http(s) posting URL, or when the student or US
 * filter rejects it (§7.7.3; US = `location.name` or any office, see
 * `isGreenhouseJobUs`). The stored `location` is still `location.name`.
 * `company` comes from `displayName`, never the payload. All fields are clamped to `JOB_DESCRIPTION_*_MAX_LENGTH`.
 * Board facets (§7.8.4) come from the title, `departments[]`, and `location.name`.
 */
export function mapGreenhouseJob(
  raw: RawGreenhouseJob,
  company: JobBoardCompany,
): ExternalJobDescriptionUpsert | null {
  const externalId = greenhouseExternalId(raw, company);
  const title = clampText(raw.title, JOB_DESCRIPTION_TITLE_MAX_LENGTH);
  const sourceUrl = httpUrlOrNull(raw.absolute_url);
  if (!externalId || !title || !sourceUrl) return null;

  const level = classifyStudentLevel(title);
  if (!level) return null;

  const location = clampText(
    raw.location?.name,
    JOB_DESCRIPTION_LOCATION_MAX_LENGTH,
  );
  if (!isGreenhouseJobUs(raw, location)) return null;

  const description =
    typeof raw.content === "string"
      ? clampText(
          stripHtml(decodeHtmlEntities(raw.content)),
          JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
        )
      : null;
  if (!description) return null;

  return {
    externalId,
    title,
    company: clampText(company.displayName, JOB_DESCRIPTION_COMPANY_MAX_LENGTH),
    description,
    sourceUrl,
    level,
    location,
    postedAt: isoDateOrNull(raw.first_published),
    ...deriveJobFacets({
      title,
      location,
      department: greenhouseDepartment(raw),
    }),
  };
}
