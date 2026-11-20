import type { ReactNode } from "react";
import Link from "next/link";
import type { JobDescription } from "@/types/domain";
import {
  displayHost,
  formatAbsoluteDate,
  formatRelativeDays,
  getJobSourceInfo,
  jobPostedAt,
  safeExternalUrl,
  toDescriptionBlocks,
} from "@/lib/client/jobsBoard";
import {
  JobLevelBadge,
  JobSourceBadge,
  OwnPostingBadge,
} from "@/components/jobs/JobBadges";
import {
  ArrowLeftIcon,
  BuildingIcon,
  ExternalLinkIcon,
  MapPinIcon,
  SparkIcon,
} from "@/components/jobs/icons";

const primaryAction =
  "inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg shadow-sm transition-colors hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const secondaryAction =
  "inline-flex w-full items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-4 py-2.5 text-sm font-medium text-fg shadow-sm transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function BackToJobsLink() {
  return (
    <Link
      href="/jobs"
      className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-fg-muted transition-colors hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <ArrowLeftIcon className="h-4 w-4" />
      All jobs
    </Link>
  );
}

/** Title, company/location line and tags at the top of `/jobs/[id]`. */
export function JobDetailHeader({ job }: { job: JobDescription }) {
  return (
    <header>
      <h1 className="text-2xl font-semibold leading-tight tracking-tight text-fg break-words sm:text-3xl">
        {job.title}
      </h1>
      {(job.company || job.location) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-base text-fg-muted">
          {job.company && (
            <span className="inline-flex items-center gap-1.5">
              <BuildingIcon className="h-4 w-4 text-fg-subtle" />
              <span className="sr-only">Company: </span>
              {job.company}
            </span>
          )}
          {job.location && (
            <span className="inline-flex items-center gap-1.5">
              <MapPinIcon className="h-4 w-4 text-fg-subtle" />
              <span className="sr-only">Location: </span>
              {job.location}
            </span>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {job.level && <JobLevelBadge level={job.level} />}
        <JobSourceBadge source={job.source} />
        {job.is_own && <OwnPostingBadge />}
      </div>
    </header>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-sm text-fg-subtle">{term}</dt>
      <dd className="min-w-0 text-right text-sm font-medium text-fg break-words">
        {children}
      </dd>
    </div>
  );
}

/**
 * Key facts and actions: posted date, level, location, source (plain label
 * for employer postings and community submissions, docs/ARCHITECTURE.md
 * §7.7.9; an attribution link-back only for legacy The Muse rows, §7.1),
 * an "apply / view original" link to `source_url`, and, when the caller has
 * an analyzed resume, a jump to the match section.
 *
 * `source_url` passes through `safeExternalUrl` (http/https only) before it
 * becomes an `href`, opens in a new tab with `rel="noopener noreferrer"`, and
 * is labelled as external both visually (icon + host) and for screen readers.
 */
export function JobKeyFacts({
  job,
  canMatch,
  now,
}: {
  job: JobDescription;
  /** The caller has at least one analyzed resume, so the match flow is usable. */
  canMatch: boolean;
  now?: number;
}) {
  const source = getJobSourceInfo(job.source);
  const postedAt = jobPostedAt(job);
  const relative = formatRelativeDays(postedAt, now);
  const absolute = formatAbsoluteDate(postedAt);
  const applyUrl = safeExternalUrl(job.source_url);
  const host = displayHost(job.source_url);
  const showMatchCta = canMatch && !job.deleted_at;

  return (
    <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-fg">Key facts</h2>
      <dl className="mt-3 divide-y divide-border">
        {absolute && (
          <Fact term="Posted">
            <time dateTime={postedAt} suppressHydrationWarning>
              {absolute}
            </time>
            {relative && (
              <span
                className="block text-xs font-normal text-fg-subtle"
                suppressHydrationWarning
              >
                {relative}
              </span>
            )}
          </Fact>
        )}
        <Fact term="Level">{job.level ?? "Not specified"}</Fact>
        <Fact term="Location">{job.location ?? "Not specified"}</Fact>
        {job.company && <Fact term="Company">{job.company}</Fact>}
        <Fact term="Source">
          {source.attribution ? (
            <a
              href={source.attribution.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded underline underline-offset-4 hover:text-fg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {source.attribution.text}
              <ExternalLinkIcon className="h-3.5 w-3.5" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            source.label
          )}
          <span className="block text-xs font-normal text-fg-subtle">
            {source.description}
          </span>
        </Fact>
      </dl>

      {(showMatchCta || applyUrl) && (
        <div className="mt-5 flex flex-col gap-2">
          {showMatchCta && (
            <a href="#match" className={primaryAction}>
              <SparkIcon className="h-4 w-4" />
              Check my fit
            </a>
          )}
          {applyUrl && (
            <a
              href={applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={showMatchCta ? secondaryAction : primaryAction}
            >
              {source.applyLabel}
              <ExternalLinkIcon className="h-4 w-4" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
          {applyUrl && host && (
            <p className="text-center text-xs text-fg-subtle">
              Opens {host} in a new tab
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The job description as readable text: headings, paragraphs and bullet
 * lists derived by `toDescriptionBlocks`. Every string is rendered as a React
 * text node, never as HTML, so markup in a description can't execute.
 */
export function JobDescriptionBody({ description }: { description: string }) {
  const blocks = toDescriptionBlocks(description);

  return (
    <section
      aria-labelledby="job-description-heading"
      className="rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6"
    >
      <h2 id="job-description-heading" className="text-lg font-semibold text-fg">
        About the role
      </h2>
      {blocks.length === 0 ? (
        <p className="mt-3 text-sm text-fg-subtle">No description provided.</p>
      ) : (
        <div className="mt-4 flex max-w-prose flex-col gap-4 text-[0.9375rem] leading-7 text-fg-muted">
          {blocks.map((block, index) => {
            if (block.type === "heading") {
              return (
                <h3 key={index} className="pt-2 text-base font-semibold text-fg">
                  {block.text}
                </h3>
              );
            }
            if (block.type === "list") {
              return (
                <ul key={index} className="flex list-disc flex-col gap-1.5 pl-5 marker:text-fg-subtle">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex}>{item}</li>
                  ))}
                </ul>
              );
            }
            return (
              <p key={index} className="whitespace-pre-line">
                {block.lines.join("\n")}
              </p>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** "Removed" notice for a soft-deleted posting (docs/ARCHITECTURE.md §10.5). */
export function RemovedPostingNotice({ isOwn }: { isOwn: boolean }) {
  return (
    <p
      role="status"
      className="rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-fg"
    >
      <span className="font-semibold">Removed. </span>
      {isOwn
        ? "You removed this posting. It no longer appears in browsing or search, and existing matches against it are unaffected."
        : "This posting has been removed by the person who shared it. Existing matches against it still work."}
    </p>
  );
}

/** Inline error when the posting itself couldn't be loaded. */
export function JobDetailErrorState({ id }: { id: string }) {
  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
      <BackToJobsLink />
      <div
        role="alert"
        className="mt-6 rounded-lg border border-danger-border bg-danger-bg px-5 py-6"
      >
        <h1 className="text-lg font-semibold text-danger-fg">
          We couldn&apos;t load this job
        </h1>
        <p className="mt-1 text-sm text-danger-fg">
          This is usually temporary. Please try again in a moment.
        </p>
        <a
          href={`/jobs/${encodeURIComponent(id)}`}
          className="mt-4 inline-flex items-center justify-center rounded-md border border-danger-border bg-surface px-4 py-2 text-sm font-medium text-danger-fg shadow-sm transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Try again
        </a>
      </div>
    </div>
  );
}

/**
 * Full `/jobs/[id]` layout. Presentational: the page supplies the
 * interactive pieces as slots (the existing `MatchFromJobForm`, and the
 * owner's edit/remove controls), so this renders identically in tests and
 * previews.
 *
 * Phone: header, key facts + actions, description, match, owner tools.
 * Desktop: the same, with key facts in a sticky right-hand column.
 */
export function JobDetailView({
  job,
  canMatch,
  matchSection,
  ownerTools,
  now,
}: {
  job: JobDescription;
  canMatch: boolean;
  /** Content of the "Check your fit" section, or `null` to omit it (removed posting). */
  matchSection: ReactNode;
  /** Edit/remove controls; only passed when `job.is_own`. */
  ownerTools?: ReactNode;
  now?: number;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
      <BackToJobsLink />

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-8">
        <div className="flex flex-col gap-4 lg:col-start-1 lg:row-start-1">
          <JobDetailHeader job={job} />
          {job.deleted_at && <RemovedPostingNotice isOwn={job.is_own} />}
        </div>

        <aside
          aria-label="Job summary"
          className="lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start"
        >
          <JobKeyFacts job={job} canMatch={canMatch} now={now} />
        </aside>

        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-2">
          <JobDescriptionBody description={job.description} />

          {matchSection && (
            <section
              id="match"
              aria-labelledby="match-heading"
              className="scroll-mt-6 rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6"
            >
              <h2 id="match-heading" className="text-lg font-semibold text-fg">
                Check your fit
              </h2>
              <p className="mt-1 text-sm text-fg-muted">
                Compare this role with one of your analyzed resumes to see a fit
                score, strengths and gaps. Your resume and results stay private
                to you.
              </p>
              <div className="mt-4">{matchSection}</div>
            </section>
          )}

          {ownerTools && (
            <section
              aria-labelledby="owner-tools-heading"
              className="rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6"
            >
              <h2 id="owner-tools-heading" className="text-lg font-semibold text-fg">
                Manage your posting
              </h2>
              <div className="mt-4">{ownerTools}</div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
