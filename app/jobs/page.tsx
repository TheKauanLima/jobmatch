import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { JobDescriptionForm } from "@/components/jobs/JobDescriptionForm";
import {
  JobsBoardLayout,
  JobsResults,
  type JobsFirstPage,
} from "@/components/jobs/JobsBoard";
import { JobsResultsSkeleton } from "@/components/jobs/JobsBoardStates";
import {
  buildJobsApiPath,
  jobsQueryKey,
  parseJobsFacets,
  parseJobsSearchParams,
  type JobsBoardQuery,
  type JobsFacets,
} from "@/lib/client/jobsBoard";

export const metadata: Metadata = {
  title: "Jobs · Kalify",
};

async function getFirstPage(query: JobsBoardQuery): Promise<JobsFirstPage> {
  try {
    const response = await serverFetch(buildJobsApiPath(query));
    if (!response.ok) {
      return { kind: "error" };
    }
    const body = await response.json();
    return {
      kind: "ok",
      jobDescriptions: body.job_descriptions ?? [],
      nextCursor: body.next_cursor ?? null,
    };
  } catch {
    return { kind: "error" };
  }
}

/**
 * Global filter counts (docs/ARCHITECTURE.md §7.8.6). Never throws: any
 * failure (or an unexpected body) is `null`, which the filter bar handles by
 * enabling every field and offering only "Any location" / "Remote".
 */
async function getFacets(): Promise<JobsFacets | null> {
  try {
    const response = await serverFetch("/api/job-descriptions/facets");
    if (!response.ok) return null;
    return parseJobsFacets(await response.json());
  } catch {
    return null;
  }
}

/** Awaits one query's first page and renders it; streamed in under Suspense. */
async function JobsResultsLoader({
  query,
  firstPage,
}: {
  query: JobsBoardQuery;
  firstPage: Promise<JobsFirstPage>;
}) {
  return <JobsResults query={query} firstPage={await firstPage} />;
}

interface JobsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `/jobs` — the shared jobs board (docs/ARCHITECTURE.md §2, §7, §7.8, §9).
 * Search, filters and sort live in the URL.
 *
 * The first results page and the filter facets are requested in parallel.
 * The facets are awaited here, outside the results Suspense boundary, so the
 * filter bar renders with its final options; the results stream in under a
 * Suspense boundary keyed on the query, so a new search shows the results
 * skeleton straight away instead of a frozen page. `getFirstPage` never
 * rejects, so starting it before awaiting the facets is safe.
 */
export default async function JobsPage({ searchParams }: JobsPageProps) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const query = parseJobsSearchParams(await searchParams);
  const firstPage = getFirstPage(query);
  const facets = await getFacets();

  return (
    <JobsBoardLayout
      query={query}
      facets={facets}
      submitForm={<JobDescriptionForm embedded />}
    >
      <Suspense key={jobsQueryKey(query)} fallback={<JobsResultsSkeleton />}>
        <JobsResultsLoader query={query} firstPage={firstPage} />
      </Suspense>
    </JobsBoardLayout>
  );
}
