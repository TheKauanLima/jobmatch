"use client";

import { useState } from "react";
import type { JobDescription } from "@/types/domain";
import { JobDescriptionCard } from "@/components/jobs/JobDescriptionCard";
import { Button } from "@/components/ui/Button";

interface JobDescriptionListProps {
  initialJobDescriptions: JobDescription[];
  initialNextCursor: string | null;
}

/**
 * Renders the shared job description list with a "Load more" control that
 * pages through `GET /api/job-descriptions` using the opaque `next_cursor`
 * token (see docs/ARCHITECTURE.md §2) — passed back verbatim, never
 * constructed manually.
 *
 * Deliberately does NOT copy `initialJobDescriptions`/`initialNextCursor`
 * into `useState` as the "base" list. `app/jobs/page.tsx` calls
 * `router.refresh()` after a submission, which re-runs the server component
 * and passes fresh props down to this *same* client component instance —
 * React does not re-run `useState`'s initializer on a prop change, so a
 * naive `useState(initialJobDescriptions)` would silently show stale data
 * forever after the first mount (a submitted job description would never
 * appear without a hard navigation). Instead, the base page is always read
 * directly from props (so it's guaranteed fresh on every render), and only
 * the *additional* pages fetched via "Load more" are owned as local state,
 * appended after the base.
 *
 * Known tradeoff: if a submission lands while additional pages are already
 * loaded, the freshly-inserted row shifts the keyset boundary by one, which
 * can (rarely) duplicate or skip a single row at the seam between the base
 * page and previously-loaded additional pages. This is an inherent limit of
 * keyset pagination over a live-inserted feed, not something worth adding
 * complexity to fully solve for v1 — the important guarantee (a submission
 * always visibly appears without a hard reload) holds either way. The
 * duplicate case specifically is de-duped by `id` below so it can never
 * produce two list items sharing a React `key`.
 */
export function JobDescriptionList({
  initialJobDescriptions,
  initialNextCursor,
}: JobDescriptionListProps) {
  const [additionalJobDescriptions, setAdditionalJobDescriptions] = useState<
    JobDescription[]
  >([]);
  // Cursor to use for the *next* "Load more" fetch, once at least one has
  // happened. `null` (the initial value) means "no Load more yet" — in that
  // state the effective cursor is always `initialNextCursor` from props, not
  // this state, so a fresh submission's updated cursor is picked up too.
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

  async function handleLoadMore() {
    if (!nextCursor) return;

    setError(null);
    setLoadingMore(true);
    try {
      const response = await fetch(
        `/api/job-descriptions?cursor=${encodeURIComponent(nextCursor)}`,
      );

      if (!response.ok) {
        setError("Couldn't load more job descriptions. Please try again.");
        return;
      }

      const body = await response.json();
      setAdditionalJobDescriptions((prev) => [
        ...prev,
        ...(body.job_descriptions ?? []),
      ]);
      setLoadedCursor(body.next_cursor ?? null);
    } catch {
      setError("Couldn't load more job descriptions. Please try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  if (jobDescriptions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong bg-surface p-8 text-center">
        <p className="text-sm text-fg-muted">
          No job descriptions yet. Be the first to submit one above.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {jobDescriptions.map((jobDescription) => (
        <JobDescriptionCard
          key={jobDescription.id}
          jobDescription={jobDescription}
        />
      ))}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </p>
      )}

      {nextCursor && (
        <Button
          type="button"
          variant="secondary"
          loading={loadingMore}
          onClick={handleLoadMore}
          className="self-center"
        >
          Load more
        </Button>
      )}
    </div>
  );
}
