"use client";

import { useState } from "react";
import type { JobDescription } from "@/types/domain";
import { JobDescriptionCard } from "@/components/jobs/JobDescriptionCard";
import { JobsEmptyState } from "@/components/jobs/JobsBoardStates";
import { Button } from "@/components/ui/Button";
import {
  buildJobsApiPath,
  formatResultSummary,
  type JobsBoardQuery,
} from "@/lib/client/jobsBoard";

interface JobDescriptionListProps {
  initialJobDescriptions: JobDescription[];
  initialNextCursor: string | null;
  /**
   * Search and filters currently applied (docs/ARCHITECTURE.md §7.8.7).
   * Only used to keep "Load more" fetches on the same query as the first
   * page and to word the result count/empty state. The filter UI itself is
   * plain navigation (`JobsSearchControls`); the page remounts this
   * component via a `key` (`jobsQueryKey`) whenever the query changes, so
   * loaded pages never leak from one search into another.
   */
  query: JobsBoardQuery;
  /** Reference time for relative dates; injectable for tests. */
  now?: number;
}

/**
 * The shared job list: result count, cards, and a "Load more" control that
 * pages through `GET /api/job-descriptions` with the opaque `next_cursor`
 * (passed back verbatim, never constructed; docs/ARCHITECTURE.md §2/§9.2).
 *
 * Deliberately does NOT copy `initialJobDescriptions`/`initialNextCursor`
 * into `useState`. `JobDescriptionForm` calls `router.refresh()` after a
 * submission, which passes fresh props to this same instance; React doesn't
 * re-run a `useState` initializer on prop change, so the first page is read
 * from props on every render and only the *additional* pages are local
 * state, appended after it (de-duplicated by `id`, since a fresh insert can
 * shift the keyset boundary by one row).
 */
export function JobDescriptionList({
  initialJobDescriptions,
  initialNextCursor,
  query,
  now,
}: JobDescriptionListProps) {
  const [additionalJobDescriptions, setAdditionalJobDescriptions] = useState<
    JobDescription[]
  >([]);
  // Cursor for the *next* "Load more", once at least one has happened. Until
  // then the effective cursor is `initialNextCursor` from props.
  const [loadedCursor, setLoadedCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seenIds = new Set(initialJobDescriptions.map((jd) => jd.id));
  const jobDescriptions = [
    ...initialJobDescriptions,
    ...additionalJobDescriptions.filter((jd) => {
      if (seenIds.has(jd.id)) return false;
      seenIds.add(jd.id);
      return true;
    }),
  ];
  const nextCursor =
    additionalJobDescriptions.length > 0 ? loadedCursor : initialNextCursor;
  const loadedExtraPages = additionalJobDescriptions.length > 0;

  async function handleLoadMore() {
    if (!nextCursor) return;

    setError(null);
    setLoadingMore(true);
    try {
      const response = await fetch(buildJobsApiPath(query, nextCursor));

      if (!response.ok) {
        setError("Couldn't load more jobs. Please try again.");
        return;
      }

      const body = await response.json();
      setAdditionalJobDescriptions((prev) => [
        ...prev,
        ...(body.job_descriptions ?? []),
      ]);
      setLoadedCursor(body.next_cursor ?? null);
    } catch {
      setError("Couldn't load more jobs. Check your connection and try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  if (jobDescriptions.length === 0) {
    return <JobsEmptyState query={query} />;
  }

  return (
    <section aria-labelledby="jobs-results-heading">
      <h2 id="jobs-results-heading" className="sr-only">
        Results
      </h2>
      <p
        aria-live="polite"
        className="text-sm font-medium text-fg-muted"
      >
        {formatResultSummary({
          count: jobDescriptions.length,
          hasMore: Boolean(nextCursor),
          ...query,
        })}
      </p>

      <ul role="list" aria-busy={loadingMore} className="mt-3 flex flex-col gap-3">
        {jobDescriptions.map((jobDescription) => (
          <li key={jobDescription.id}>
            <JobDescriptionCard jobDescription={jobDescription} now={now} />
          </li>
        ))}
      </ul>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </p>
      )}

      <div className="mt-6 flex justify-center">
        {nextCursor ? (
          <Button
            type="button"
            variant="secondary"
            loading={loadingMore}
            onClick={handleLoadMore}
          >
            Load more jobs
          </Button>
        ) : (
          loadedExtraPages && (
            <p className="text-sm text-fg-subtle">You&apos;ve reached the end of the list.</p>
          )
        )}
      </div>
    </section>
  );
}
