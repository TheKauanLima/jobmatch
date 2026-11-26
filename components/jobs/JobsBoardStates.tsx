import Link from "next/link";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  buildJobsHref,
  listActiveJobsFilters,
  type JobsBoardQuery,
} from "@/lib/client/jobsBoard";
import { SearchIcon, XIcon } from "@/components/jobs/icons";

const primaryButton =
  "inline-flex items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg shadow-sm transition-colors hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * Empty states for the jobs list (docs/ARCHITECTURE.md §7.8.7). Three cases:
 * - any filter is active (level, field, location; with or without a search)
 *   and nothing matched: "No jobs match these filters", one removable chip
 *   per applied search/filter (a link to the same URL without that param),
 *   then "Clear all";
 * - only a search is active: say what was searched and offer to clear it;
 * - nothing is applied and the board itself is empty: point at "Share a job
 *   posting".
 */
export function JobsEmptyState({ query }: { query: JobsBoardQuery }) {
  const active = listActiveJobsFilters(query);
  const searchOnly = active.length === 1 && active[0].key === "q";

  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-bg text-neutral-fg">
        <SearchIcon className="h-5 w-5" />
      </span>
      {active.length === 0 ? (
        <>
          <h2 className="mt-4 text-base font-semibold text-fg">
            No jobs on the board yet
          </h2>
          <p className="mt-1 max-w-sm text-sm text-fg-muted">
            New internship and entry-level listings arrive daily. You can also
            share a posting you&apos;ve found using &ldquo;Share a job
            posting&rdquo; above.
          </p>
        </>
      ) : searchOnly ? (
        <>
          <h2 className="mt-4 text-base font-semibold text-fg">
            No jobs match &ldquo;{query.q}&rdquo;
          </h2>
          <p className="mt-1 max-w-sm text-sm text-fg-muted">
            Try a broader keyword or check the spelling.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <Link href={buildJobsHref()} className={primaryButton}>
              Clear search
            </Link>
          </div>
        </>
      ) : (
        <>
          <h2 className="mt-4 text-base font-semibold text-fg">
            No jobs match these filters
          </h2>
          <p className="mt-1 max-w-sm text-sm text-fg-muted">
            Remove a filter to see more listings.
          </p>
          <ul
            role="list"
            aria-label="Active filters"
            className="mt-5 flex max-w-xl flex-wrap justify-center gap-2"
          >
            {active.map((filter) => (
              <li key={filter.key}>
                <Link
                  href={filter.removeHref}
                  className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-border-strong bg-surface py-1 pl-3 pr-2 text-sm sm:min-h-0 text-fg transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="sr-only">Remove filter </span>
                  <span className="text-fg-subtle">{filter.name}:</span>
                  <span className="truncate font-medium">{filter.value}</span>
                  <XIcon className="h-3.5 w-3.5 text-fg-subtle" />
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <Link href={buildJobsHref()} className={primaryButton}>
              Clear all
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Shown when the first page of results couldn't be loaded. "Try again" is a
 * plain link to the same URL (a full reload), so it works even if the error
 * came from client-side navigation state.
 */
export function JobsErrorState({ query }: { query: JobsBoardQuery }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger-border bg-danger-bg px-5 py-6"
    >
      <h2 className="text-base font-semibold text-danger-fg">
        We couldn&apos;t load jobs right now
      </h2>
      <p className="mt-1 text-sm text-danger-fg">
        This is usually temporary. Your search and filters are kept, so you can
        try again in a moment.
      </p>
      <a
        href={buildJobsHref(query)}
        className="mt-4 inline-flex items-center justify-center rounded-md border border-danger-border bg-surface px-4 py-2 text-sm font-medium text-danger-fg shadow-sm transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Try again
      </a>
    </div>
  );
}

/** Placeholder for one listing card, matching `JobDescriptionCard`'s layout. */
function JobCardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-sm sm:p-5">
      <Skeleton className="h-5 w-2/3 max-w-sm" />
      <div className="mt-2 flex gap-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-24" />
      </div>
      <Skeleton className="mt-4 h-4 w-full" />
      <Skeleton className="mt-2 h-4 w-4/5" />
      <div className="mt-4 flex items-center gap-2">
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="ml-auto h-4 w-24" />
      </div>
    </div>
  );
}

/** Results-area skeleton: used by the page's Suspense fallback and `loading.tsx`. */
export function JobsResultsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div aria-busy="true">
      <p role="status" className="sr-only">
        Loading jobs&hellip;
      </p>
      <Skeleton className="h-4 w-40" />
      <div className="mt-4 flex flex-col gap-3">
        {Array.from({ length: count }, (_, i) => (
          <JobCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
