import Link from "next/link";
import type { RecentMatch } from "@/types/domain";
import { MatchScoreBadge } from "@/components/matches/MatchScoreBadge";

interface RecentMatchCardProps {
  match: RecentMatch;
}

/**
 * Compact display of one cross-resume match result for the dashboard's
 * "Latest matches" panel (see `app/dashboard/page.tsx`) — score, job title/
 * company, and which resume it was run against (since, unlike
 * `MatchList`'s single-resume context, a cross-resume listing can't assume
 * the viewer already knows). Links into `/resumes/[id]`, same destination
 * `MatchList` itself links to for a job title — there's no standalone match
 * page per docs/ARCHITECTURE.md §3.
 */
export function RecentMatchCard({ match }: RecentMatchCardProps) {
  return (
    <Link
      href={`/resumes/${match.resume.id}`}
      className="block rounded-lg border border-border bg-surface p-4 transition-colors hover:bg-surface-hover"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">
            {match.job_description.title}
          </p>
          {match.job_description.company && (
            <p className="truncate text-sm text-fg-muted">
              {match.job_description.company}
            </p>
          )}
        </div>
        <MatchScoreBadge score={match.score} className="shrink-0" />
      </div>
      <p className="mt-2 truncate text-xs text-fg-subtle">
        {match.resume.file_name}
      </p>
    </Link>
  );
}
