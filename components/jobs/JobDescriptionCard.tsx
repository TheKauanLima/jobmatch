import Link from "next/link";
import type { JobDescription } from "@/types/domain";
import {
  formatAbsoluteDate,
  formatRelativeDays,
  jobPostedAt,
  makeSnippet,
} from "@/lib/client/jobsBoard";
import {
  JobLevelBadge,
  JobSourceBadge,
  OwnPostingBadge,
} from "@/components/jobs/JobBadges";
import { BuildingIcon, ClockIcon, MapPinIcon } from "@/components/jobs/icons";

interface JobDescriptionCardProps {
  jobDescription: JobDescription;
  /** Reference time for the relative date; injectable for tests. */
  now?: number;
  /** Heading level for the title, so the card fits the page outline it sits in. */
  headingLevel?: "h2" | "h3";
}

/**
 * One listing on the jobs board (also reused by the dashboard's "Latest job
 * listings" panel): title, company and location, a plain-text description
 * snippet, level and source tags, and a relative "posted" date.
 *
 * The whole card is clickable via a stretched link on the title (the link's
 * `::after` covers the card), so screen readers hear just the job title as
 * the link name instead of the entire card's text, and keyboard focus shows
 * as an outline around the whole card.
 *
 * The description is untrusted text: it goes through `makeSnippet` (strips
 * any markup, flattens whitespace) and is rendered as a text node.
 */
export function JobDescriptionCard({
  jobDescription,
  now,
  headingLevel = "h3",
}: JobDescriptionCardProps) {
  const Heading = headingLevel;
  const postedAt = jobPostedAt(jobDescription);
  const relative = formatRelativeDays(postedAt, now);
  const absolute = formatAbsoluteDate(postedAt);
  const snippet = makeSnippet(jobDescription.description, 200);

  return (
    <article className="relative flex h-full flex-col rounded-lg border border-border bg-surface p-4 shadow-sm transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent hover:border-border-strong hover:bg-surface-hover sm:p-5">
      <Heading className="text-base font-semibold leading-snug text-fg">
        <Link
          href={`/jobs/${jobDescription.id}`}
          className="break-words after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none"
        >
          {jobDescription.title}
        </Link>
      </Heading>

      {(jobDescription.company || jobDescription.location) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
          {jobDescription.company && (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <BuildingIcon className="h-4 w-4 text-fg-subtle" />
              <span className="sr-only">Company: </span>
              <span className="truncate">{jobDescription.company}</span>
            </span>
          )}
          {jobDescription.location && (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <MapPinIcon className="h-4 w-4 text-fg-subtle" />
              <span className="sr-only">Location: </span>
              <span className="truncate">{jobDescription.location}</span>
            </span>
          )}
        </div>
      )}

      {snippet && (
        <p className="mt-3 line-clamp-2 text-sm leading-6 text-fg-subtle">
          {snippet}
        </p>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {jobDescription.level && <JobLevelBadge level={jobDescription.level} />}
        <JobSourceBadge source={jobDescription.source} />
        {jobDescription.is_own && <OwnPostingBadge />}
        {relative && (
          <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap text-xs text-fg-subtle">
            <ClockIcon className="h-3.5 w-3.5" />
            <time
              dateTime={postedAt}
              title={absolute ?? undefined}
              suppressHydrationWarning
            >
              Posted {relative}
            </time>
          </span>
        )}
      </div>
    </article>
  );
}
