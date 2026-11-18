import Link from "next/link";
import { Skeleton } from "@/components/ui/Skeleton";
import { buildJobsHref, type JobsBoardQuery } from "@/lib/client/jobsBoard";
import { SearchIcon } from "@/components/jobs/icons";

/**
 * Empty states for the jobs list. Two distinct cases:
 * - a search/filter is active and nothing matched: say what was searched and
 *   offer a one-click reset (and, when both are set, a way to drop just the
 *   level filter);
 * - the board itself is empty: point at "Share a job posting".
 */
export function JobsEmptyState({ query }: { query: JobsBoardQuery }) {
  const filtered = Boolean(query.q || query.level);

  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-bg text-neutral-fg">
        <SearchIcon className="h-5 w-5" />
      </span>
      {filtered ? (
        <>
          <h2 className="mt-4 text-base font-semibold text-fg">
            No jobs match{" "}
            {query.q ? <>&ldquo;{query.q}&rdquo;</> : "this filter"}
            {query.q && query.level ? ` in ${query.level}` : ""}
          </h2>
          <p className="mt-1 max-w-sm text-sm text-fg-muted">
            Try a broader keyword, check the spelling, or search across all
            levels.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            {query.q && query.level && (
              <Link
                href={buildJobsHref({ q: query.q })}
                className="inline-flex items-center justify-center rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-fg shadow-sm transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Search all levels
              </Link>
            )}
            <Link
              href={buildJobsHref()}
              className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg shadow-sm transition-colors hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Clear search and filters
            </Link>
          </div>
        </>
      ) : (
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
