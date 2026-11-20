import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildResumeOverview,
  critiqueQuotaFrom,
  pickTopMatches,
  TOP_MATCHES_SCAN_LIMIT,
  type DashboardData,
  type DashboardResumes,
  type Section,
} from "@/lib/client/dashboard";
import { getMyRateLimits } from "@/lib/rateLimit";
import { listLatestCritiqueSummaries } from "@/lib/supabase/queries/critiques";
import { listRecentMatchesForUser } from "@/lib/supabase/queries/matches";
import { listResumesForUser } from "@/lib/supabase/queries/resumes";
import type { Database } from "@/types/database";
import { toRecentMatch, toResumeListItem, type RecentMatch } from "@/types/domain";

type SessionClient = SupabaseClient<Database>;

/** The query functions the loader uses; injectable for tests. */
export interface DashboardQueries {
  listResumesForUser: typeof listResumesForUser;
  listLatestCritiqueSummaries: typeof listLatestCritiqueSummaries;
  listRecentMatchesForUser: typeof listRecentMatchesForUser;
  getMyRateLimits: typeof getMyRateLimits;
}

const DEFAULT_QUERIES: DashboardQueries = {
  listResumesForUser,
  listLatestCritiqueSummaries,
  listRecentMatchesForUser,
  getMyRateLimits,
};

/** Logs the section and error class only: never row content, ids or query text. */
function logFailure(section: string, err: unknown) {
  console.error(
    `dashboard: failed to load ${section}:`,
    err instanceof Error ? err.name : "unknown error",
  );
}

async function loadResumes(
  supabase: SessionClient,
  userId: string,
  queries: DashboardQueries,
): Promise<Section<DashboardResumes>> {
  let resumes;
  try {
    resumes = (await queries.listResumesForUser(supabase, userId)).map(toResumeListItem);
  } catch (err) {
    logFailure("resumes", err);
    return { status: "error" };
  }

  try {
    const critiques = await queries.listLatestCritiqueSummaries(
      supabase,
      userId,
      resumes.map((resume) => resume.id),
    );
    return {
      status: "ok",
      data: { items: buildResumeOverview(resumes, critiques), critiquesFailed: false },
    };
  } catch (err) {
    logFailure("critique summaries", err);
    return {
      status: "ok",
      data: { items: buildResumeOverview(resumes, []), critiquesFailed: true },
    };
  }
}

async function loadTopMatches(
  supabase: SessionClient,
  userId: string,
  queries: DashboardQueries,
): Promise<Section<RecentMatch[]>> {
  try {
    const { items } = await queries.listRecentMatchesForUser(supabase, userId, {
      limit: TOP_MATCHES_SCAN_LIMIT,
    });
    const matches = items.map((row) => toRecentMatch(row, row.job_description, row.resume));
    return { status: "ok", data: pickTopMatches(matches) };
  } catch (err) {
    logFailure("matches", err);
    return { status: "error" };
  }
}

async function loadQuota(
  supabase: SessionClient,
  queries: DashboardQueries,
): Promise<DashboardData["quota"]> {
  try {
    return { status: "ok", data: critiqueQuotaFrom(await queries.getMyRateLimits(supabase)) };
  } catch (err) {
    logFailure("usage limits", err);
    return { status: "error" };
  }
}

/**
 * Loads everything the dashboard shows, through the caller's RLS-scoped
 * session client and the existing query modules only (no admin client, no
 * Claude calls). `userId` must be the verified session user. Each section
 * fails independently, so one broken query never blanks the whole page.
 */
export async function loadDashboard(
  supabase: SessionClient,
  userId: string,
  queries: DashboardQueries = DEFAULT_QUERIES,
): Promise<DashboardData> {
  const [resumes, matches, quota] = await Promise.all([
    loadResumes(supabase, userId, queries),
    loadTopMatches(supabase, userId, queries),
    loadQuota(supabase, queries),
  ]);
  return { resumes, matches, quota };
}
