"use client";

import { useState } from "react";
import Link from "next/link";
import type { RecentMatch } from "@/types/domain";
import { MatchScoreBadge } from "@/components/matches/MatchScoreBadge";
import { MatchRationale } from "@/components/matches/MatchRationale";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

interface MatchHistoryListProps {
  initialMatches: RecentMatch[];
  initialNextCursor: string | null;
}

/**
 * Renders `/matches`' full cross-resume match history with a "Load more"
 * control that pages through `GET /api/matches` (no `resume_id`) using the
 * opaque `next_cursor` token, per docs/ARCHITECTURE.md §11 — same "own
 * additional pages as local state, read the base page from props" pattern
 * as `JobDescriptionList` (see that component's doc comment for the full
 * reasoning, including why `initialMatches`/`initialNextCursor` are read
 * directly from props rather than copied into `useState` once: this page
 * has no submission flow of its own that would call `router.refresh()`, but
 * following the same pattern keeps this component correct if one is ever
 * added, and avoids the stale-state pitfall that pattern exists to prevent).
 *
 * Every row renders the full `MatchRationale` block, unlike
 * `JobDescriptionList`'s cards — per §11.2/§11.3, there is no
 * `/matches/:id` detail route to link into, so nothing here is
 * summarized/collapsed.
 */
export function MatchHistoryList({
  initialMatches,
  initialNextCursor,
}: MatchHistoryListProps) {
  const [additionalMatches, setAdditionalMatches] = useState<RecentMatch[]>(
    [],
  );
  // Cursor to use for the *next* "Load more" fetch, once at least one has
  // happened. `null` (the initial value) means "no Load more yet" — see
  // `JobDescriptionList`'s identical `loadedCursor` for why the effective
  // cursor below falls back to `initialNextCursor` in that state.
  const [loadedCursor, setLoadedCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seenIds = new Set(initialMatches.map((match) => match.id));
  const matches = [
    ...initialMatches,
    ...additionalMatches.filter((match) => {
      if (seenIds.has(match.id)) return false;
      seenIds.add(match.id);
      return true;
    }),
  ];
  const nextCursor =
    additionalMatches.length > 0 ? loadedCursor : initialNextCursor;

  async function handleLoadMore() {
    if (!nextCursor) return;

    setError(null);
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "20", cursor: nextCursor });
      const response = await fetch(`/api/matches?${params}`);

      if (!response.ok) {
        setError("Couldn't load more matches. Please try again.");
        return;
      }

      const body = await response.json();
      setAdditionalMatches((prev) => [...prev, ...(body.matches ?? [])]);
      setLoadedCursor(body.next_cursor ?? null);
    } catch {
      setError("Couldn't load more matches. Please try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  if (matches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong bg-surface p-6 text-center">
        <p className="text-sm text-fg-muted">
          No matches yet.{" "}
          <Link href="/resumes" className="underline hover:text-fg">
            Upload a resume
          </Link>{" "}
          to start one.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {matches.map((match) => (
        <div
          key={match.id}
          className="rounded-lg border border-border bg-surface shadow-sm p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <MatchScoreBadge score={match.score} />
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Link
                    href={`/jobs/${match.job_description.id}`}
                    className="truncate text-sm font-medium text-fg hover:underline"
                  >
                    {match.job_description.title}
                  </Link>
                  {match.job_description.deleted_at && <Badge>Removed</Badge>}
                </div>
                {match.job_description.company && (
                  <p className="truncate text-sm text-fg-muted">
                    {match.job_description.company}
                  </p>
                )}
                <Link
                  href={`/resumes/${match.resume.id}`}
                  className="truncate text-xs text-fg-subtle hover:text-fg-muted hover:underline"
                >
                  {match.resume.file_name}
                </Link>
              </div>
            </div>
            <span className="shrink-0 text-xs text-fg-subtle">
              {new Date(match.created_at).toLocaleString()}
            </span>
          </div>

          <div className="mt-4">
            <MatchRationale match={match} />
          </div>
        </div>
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
