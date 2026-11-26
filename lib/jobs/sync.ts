/**
 * Daily external-job sync: polls every company board in
 * `JOB_BOARD_COMPANIES` (Greenhouse + Lever public job-board APIs), keeps
 * student-relevant US listings, upserts them into the shared
 * `job_descriptions` board, and soft-deletes listings that have left their
 * board. Design: docs/ARCHITECTURE.md §7.7 (replaced The Muse, whose API now
 * answers automated requests with a Cloudflare 403).
 *
 * Invoked by `app/api/cron/sync-jobs/route.ts` (Vercel Cron, once a day),
 * which owns auth and passes the service-role client.
 *
 * Runtime budget (§7.7.5): companies run through a pool of
 * `SYNC_CONCURRENCY` workers; each fetch has its own
 * `REQUEST_TIMEOUT_MS` timeout; no new fetch starts after `RUN_BUDGET_MS`;
 * no retries (one request per board per run, failures wait for tomorrow).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";
import {
  softDeleteMissingExternalJobDescriptions,
  upsertExternalJobDescriptions,
  type ExternalJobDescriptionUpsert,
} from "@/lib/supabase/queries/jobDescriptions";
import {
  JOB_BOARD_COMPANIES,
  type JobBoardCompany,
  type JobBoardProvider,
} from "@/lib/jobs/sources/companies";
import { JobBoardFetchError } from "@/lib/jobs/sources/common";
import {
  fetchGreenhouseBoard,
  greenhouseExternalId,
  mapGreenhouseJob,
  type RawGreenhouseJob,
} from "@/lib/jobs/sources/greenhouse";
import {
  fetchLeverBoard,
  leverExternalId,
  mapLeverJob,
  type RawLeverPosting,
} from "@/lib/jobs/sources/lever";

type Client = SupabaseClient<Database>;

/** Companies fetched in parallel (§7.7.5). */
export const SYNC_CONCURRENCY = 4;
/** Per-request timeout (§7.7.5). */
export const REQUEST_TIMEOUT_MS = 15_000;
/** No new company fetch starts once this much time has passed (§7.7.5). */
export const RUN_BUDGET_MS = 40_000;

export type SyncCompanyStatus =
  | "ok"
  | "not_found"
  | "error"
  | "skipped_time_budget";

export type SyncCompanyResult = {
  provider: JobBoardProvider;
  token: string;
  status: SyncCompanyStatus;
  /** Jobs on the board (unfiltered). */
  fetched: number;
  /** Jobs that passed mapping + the student/US filters, after dedupe. */
  kept: number;
  upserted: number;
  softDeleted: number;
  /** Short message: provider/token/status only. Never a response body or stack. */
  error: string | null;
};

export type SyncExternalJobsResult = {
  companies: SyncCompanyResult[];
  totalUpserted: number;
  totalSoftDeleted: number;
  durationMs: number;
};

/** One provider's fetch/map/id functions, so the per-company flow is shared. */
type ProviderAdapter<Raw> = {
  fetchBoard: (token: string, signal: AbortSignal) => Promise<Raw[]>;
  map: (raw: Raw, company: JobBoardCompany) => ExternalJobDescriptionUpsert | null;
  externalId: (raw: Raw, company: JobBoardCompany) => string | null;
};

const greenhouseAdapter: ProviderAdapter<RawGreenhouseJob> = {
  fetchBoard: fetchGreenhouseBoard,
  map: mapGreenhouseJob,
  externalId: greenhouseExternalId,
};

const leverAdapter: ProviderAdapter<RawLeverPosting> = {
  fetchBoard: fetchLeverBoard,
  map: mapLeverJob,
  externalId: leverExternalId,
};

function emptyResult(
  company: JobBoardCompany,
  status: SyncCompanyStatus,
  error: string | null,
): SyncCompanyResult {
  return {
    provider: company.provider,
    token: company.token,
    status,
    fetched: 0,
    kept: 0,
    upserted: 0,
    softDeleted: 0,
    error,
  };
}

async function syncCompany<Raw>(
  supabase: Client,
  company: JobBoardCompany,
  adapter: ProviderAdapter<Raw>,
): Promise<SyncCompanyResult> {
  const { provider, token } = company;

  // 1. Fetch the full board snapshot. Any failure skips the remaining steps,
  //    in particular the soft-delete (a partial/failed snapshot must never
  //    close rows).
  let rawJobs: Raw[];
  try {
    rawJobs = await adapter.fetchBoard(
      token,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
  } catch (err) {
    if (err instanceof JobBoardFetchError) {
      return emptyResult(
        company,
        err.status === 404 ? "not_found" : "error",
        err.message,
      );
    }
    return emptyResult(company, "error", `${provider} board "${token}" failed`);
  }

  // 2. Map + filter, dedupe by externalId (one upsert statement can't touch
  //    the same conflict key twice). The *unfiltered* id set is collected
  //    separately for the soft-delete step.
  const presentExternalIds = new Set<string>();
  const rowsByExternalId = new Map<string, ExternalJobDescriptionUpsert>();
  for (const raw of rawJobs) {
    const externalId = adapter.externalId(raw, company);
    if (externalId) presentExternalIds.add(externalId);

    const row = adapter.map(raw, company);
    if (row && !rowsByExternalId.has(row.externalId)) {
      rowsByExternalId.set(row.externalId, row);
    }
  }
  const rows = [...rowsByExternalId.values()];
  const result: SyncCompanyResult = {
    ...emptyResult(company, "ok", null),
    fetched: rawJobs.length,
    kept: rows.length,
  };

  // 3. Upsert (also clears deleted_at for listings that reappeared).
  try {
    result.upserted = (
      await upsertExternalJobDescriptions(supabase, provider, rows)
    ).count;
  } catch (err) {
    logStepFailure("upsert", company, err);
    return {
      ...result,
      status: "error",
      error: `${provider} board "${token}": saving listings failed`,
    };
  }

  // 4. Snapshot close: only reached after a complete 200 and a successful
  //    upsert. Compares against the unfiltered ids, so a filter change can't
  //    mass-delete rows that are still on the board.
  try {
    result.softDeleted = (
      await softDeleteMissingExternalJobDescriptions(
        supabase,
        provider,
        token,
        presentExternalIds,
      )
    ).count;
  } catch (err) {
    logStepFailure("soft-delete", company, err);
    return {
      ...result,
      status: "error",
      error: `${provider} board "${token}": closing removed listings failed`,
    };
  }

  return result;
}

/**
 * Logs a DB-step failure server-side. Only the error class name and its
 * message (a Postgres/PostgREST message about public job-board data, never
 * resume content) are logged; nothing here comes from a provider response
 * body.
 */
function logStepFailure(
  step: string,
  company: JobBoardCompany,
  err: unknown,
): void {
  console.error(
    `[syncExternalJobs] ${step} failed for ${company.provider}:${company.token}:`,
    err instanceof Error ? `${err.name}: ${err.message}` : "unknown error",
  );
}

function syncOne(
  supabase: Client,
  company: JobBoardCompany,
): Promise<SyncCompanyResult> {
  switch (company.provider) {
    case "greenhouse":
      return syncCompany(supabase, company, greenhouseAdapter);
    case "lever":
      return syncCompany(supabase, company, leverAdapter);
  }
}

/**
 * Runs one sync pass over `companies` (default `JOB_BOARD_COMPANIES`).
 * `supabase` must be the service-role client (`lib/supabase/admin.ts`).
 * `now` is injectable for tests of the time budget.
 *
 * Never throws for a per-company problem: a 404 is reported as
 * `not_found`, any other failure as `error`, companies not started before
 * the budget ran out as `skipped_time_budget`, and the run carries on.
 * Results are returned in the same order as `companies`.
 */
export async function syncExternalJobs(
  supabase: Client,
  opts: {
    companies?: readonly JobBoardCompany[];
    now?: () => number;
  } = {},
): Promise<SyncExternalJobsResult> {
  const companies = opts.companies ?? JOB_BOARD_COMPANIES;
  const now = opts.now ?? Date.now;
  const startedAt = now();

  const results: SyncCompanyResult[] = new Array(companies.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < companies.length) {
      const index = nextIndex++;
      const company = companies[index];
      if (now() - startedAt >= RUN_BUDGET_MS) {
        results[index] = emptyResult(company, "skipped_time_budget", null);
        continue;
      }
      try {
        results[index] = await syncOne(supabase, company);
      } catch (err) {
        // Defensive: an unexpected throw (e.g. a mapper bug) must not abort
        // the other companies.
        logStepFailure("sync", company, err);
        results[index] = emptyResult(
          company,
          "error",
          `${company.provider} board "${company.token}" failed`,
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(SYNC_CONCURRENCY, companies.length) },
      () => worker(),
    ),
  );

  return {
    companies: results,
    totalUpserted: results.reduce((sum, r) => sum + r.upserted, 0),
    totalSoftDeleted: results.reduce((sum, r) => sum + r.softDeleted, 0),
    durationMs: now() - startedAt,
  };
}
