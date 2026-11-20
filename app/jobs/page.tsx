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
  parseJobsSearchParams,
  type JobsBoardQuery,
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

/** Fetches and renders one query's results; streamed in under Suspense. */
async function JobsResultsLoader({ query }: { query: JobsBoardQuery }) {
  const firstPage = await getFirstPage(query);
  return <JobsResults query={query} firstPage={firstPage} />;
}

interface JobsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `/jobs` — the shared jobs board (docs/ARCHITECTURE.md §2, §7, §9). Search
 * and level filter live in the URL. The page chrome renders immediately; the
 * results stream in under a Suspense boundary keyed on the query, so a new
 * search shows the results skeleton straight away instead of a frozen page.
 */
export default async function JobsPage({ searchParams }: JobsPageProps) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const query = parseJobsSearchParams(await searchParams);

  return (
    <JobsBoardLayout query={query} submitForm={<JobDescriptionForm embedded />}>
      <Suspense key={jobsQueryKey(query)} fallback={<JobsResultsSkeleton />}>
        <JobsResultsLoader query={query} />
      </Suspense>
    </JobsBoardLayout>
  );
}
