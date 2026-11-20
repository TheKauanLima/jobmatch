import type { ReactNode } from "react";
import type { JobDescription } from "@/types/domain";
import { JobDescriptionList } from "@/components/jobs/JobDescriptionList";
import { JobsErrorState } from "@/components/jobs/JobsBoardStates";
import { JobsSearchControls } from "@/components/jobs/JobsSearchControls";
import { PlusIcon } from "@/components/jobs/icons";
import { jobsQueryKey, type JobsBoardQuery } from "@/lib/client/jobsBoard";

export type JobsFirstPage =
  | { kind: "ok"; jobDescriptions: JobDescription[]; nextCursor: string | null }
  | { kind: "error" };

/**
 * Results area for one search/filter: the error state, or the paginated
 * list (which owns the result count and empty states). Keyed on the query so
 * a new search always starts from a fresh first page.
 */
export function JobsResults({
  query,
  firstPage,
  now,
}: {
  query: JobsBoardQuery;
  firstPage: JobsFirstPage;
  now?: number;
}) {
  if (firstPage.kind === "error") {
    return <JobsErrorState query={query} />;
  }
  return (
    <JobDescriptionList
      key={jobsQueryKey(query)}
      initialJobDescriptions={firstPage.jobDescriptions}
      initialNextCursor={firstPage.nextCursor}
      q={query.q}
      level={query.level}
      now={now}
    />
  );
}

/**
 * Page chrome for `/jobs`: heading, intro, a collapsed "Share a job posting"
 * panel (`submitForm`, the existing `JobDescriptionForm`), search and level
 * controls, then `children` (the results). Presentational only, so the page
 * can stream results under a Suspense boundary while this renders at once.
 */
export function JobsBoardLayout({
  query,
  submitForm,
  children,
}: {
  query: JobsBoardQuery;
  submitForm: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
          Jobs
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-fg-muted sm:text-base">
          Internship and entry-level roles from The Muse, plus postings shared
          by the Kalify community. Open a listing to read the full description
          and check how your resume fits.
        </p>
      </header>

      <details className="group mt-6 rounded-lg border border-border bg-surface shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg px-4 py-3 text-sm font-medium text-fg transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:px-5 [&::-webkit-details-marker]:hidden">
          <span className="flex flex-col">
            <span>Share a job posting</span>
            <span className="text-xs font-normal text-fg-subtle">
              Found a role elsewhere? Add it so you and others can match against
              it.
            </span>
          </span>
          <PlusIcon className="h-5 w-5 text-fg-subtle transition-transform group-open:rotate-45" />
        </summary>
        <div className="border-t border-border px-4 py-5 sm:px-5">{submitForm}</div>
      </details>

      <div className="mt-8">
        <JobsSearchControls query={query} />
      </div>

      <div className="mt-6">{children}</div>
    </div>
  );
}
