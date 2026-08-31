import Link from "next/link";
import type { Match } from "@/types/domain";
import { MatchScoreBadge } from "@/components/matches/MatchScoreBadge";
import { MatchRationale } from "@/components/matches/MatchRationale";

interface MatchListProps {
  matches: Match[];
}

/**
 * Renders a resume's matches (score badge, job title/company linking to
 * `/jobs/:id`, created date, and the full rationale/strengths/gaps below),
 * ordered as received — `GET /api/matches?resume_id=:id` already orders by
 * `created_at desc` per docs/ARCHITECTURE.md §2, so no client-side sort here.
 *
 * Deliberately a plain presentational component reading `matches` straight
 * from props with no internal `useState` mirror of the list. Unlike
 * `JobDescriptionList` (which owns "load more" pages as local state because
 * `GET /api/job-descriptions` is cursor-paginated), `GET /api/matches`
 * returns the full list in one response — there's nothing to accumulate
 * client-side. The resume detail page calls `router.refresh()` after a
 * successful `POST /api/matches` (see `RunMatchForm`), which re-runs the
 * server component and passes a freshly-fetched `matches` array down to this
 * same component instance; reading directly from props (rather than seeding
 * `useState(matches)` once) is what guarantees the newly-created match
 * actually appears without a hard navigation, avoiding the stale-state
 * pitfall called out in `JobDescriptionList`'s doc comment.
 */
export function MatchList({ matches }: MatchListProps) {
  if (matches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong bg-surface p-6 text-center">
        <p className="text-sm text-fg-muted">No matches yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {matches.map((match) => (
        <div
          key={match.id}
          className="rounded-lg border border-border bg-surface p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <MatchScoreBadge score={match.score} />
              <div className="min-w-0">
                <Link
                  href={`/jobs/${match.job_description.id}`}
                  className="truncate text-sm font-medium text-fg hover:underline"
                >
                  {match.job_description.title}
                </Link>
                {match.job_description.company && (
                  <p className="truncate text-sm text-fg-muted">
                    {match.job_description.company}
                  </p>
                )}
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
    </div>
  );
}
