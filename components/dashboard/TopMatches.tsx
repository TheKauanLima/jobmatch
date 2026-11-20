import Link from "next/link";

import { ALERT, CARD, HEADER_LINK, SECONDARY_LINK_BUTTON } from "@/components/dashboard/styles";
import { MatchScoreBadge } from "@/components/matches/MatchScoreBadge";
import { Badge } from "@/components/ui/Badge";
import { formatCritiqueDate } from "@/lib/client/critique";
import { jobHref, type Section } from "@/lib/client/dashboard";
import type { RecentMatch } from "@/types/domain";

interface TopMatchesProps {
  matches: Section<RecentMatch[]>;
}

/**
 * "Top matches": the caller's highest-scoring recent matches (picked by
 * `pickTopMatches`), each linking to the job page and the resume it was
 * run against. The rationale is model text and renders as plain text.
 */
export function TopMatches({ matches }: TopMatchesProps) {
  return (
    <section aria-labelledby="dashboard-matches-heading" className={CARD}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 id="dashboard-matches-heading" className="text-base font-semibold text-fg">
            Top matches
          </h2>
          <p className="mt-0.5 text-sm text-fg-subtle">Your highest scores among recent matches.</p>
        </div>
        {matches.status === "ok" && matches.data.length > 0 && (
          <Link href="/matches" className={HEADER_LINK}>
            All matches
          </Link>
        )}
      </div>

      {matches.status === "error" ? (
        <p role="alert" className={`mt-4 ${ALERT}`}>
          Couldn&apos;t load your matches. Please refresh the page.
        </p>
      ) : matches.data.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg p-6 text-center">
          <p className="text-sm text-fg-muted">
            No matches yet. Analyze a resume, then check it against a job listing to see how you fit.
          </p>
          <Link href="/jobs" className={`mt-3 ${SECONDARY_LINK_BUTTON}`}>
            Browse jobs
          </Link>
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {matches.data.map((match) => {
            const job = match.job_description;
            const date = formatCritiqueDate(match.created_at);
            return (
              <li key={match.id} className="rounded-lg border border-border bg-bg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link
                        href={jobHref(job.id)}
                        className="truncate rounded-sm text-sm font-medium text-fg hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {job.title}
                      </Link>
                      {job.deleted_at && <Badge>Removed</Badge>}
                    </div>
                    {job.company && <p className="truncate text-sm text-fg-muted">{job.company}</p>}
                  </div>
                  <MatchScoreBadge score={match.score} className="shrink-0" />
                </div>
                {match.rationale && (
                  <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-fg-muted">{match.rationale}</p>
                )}
                <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
                  <span className="min-w-0 truncate">
                    Resume:{" "}
                    <Link
                      href={`/resumes/${encodeURIComponent(match.resume.id)}`}
                      className="rounded-sm underline-offset-2 hover:text-fg-muted hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {match.resume.file_name}
                    </Link>
                  </span>
                  {date && (
                    <>
                      <span aria-hidden="true">&middot;</span>
                      <time dateTime={match.created_at} className="whitespace-nowrap">
                        {date}
                      </time>
                    </>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
