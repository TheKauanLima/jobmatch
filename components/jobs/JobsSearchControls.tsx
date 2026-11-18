import Form from "next/form";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import {
  buildJobsHref,
  JOB_LEVEL_FILTERS,
  JOBS_SEARCH_MAX_LENGTH,
  type JobLevelFilter,
  type JobsBoardQuery,
} from "@/lib/client/jobsBoard";
import { CheckIcon, SearchIcon } from "@/components/jobs/icons";

const pillBase =
  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const pillActive = "bg-accent text-accent-fg";
const pillInactive =
  "border border-border-strong bg-surface text-fg-muted hover:bg-surface-hover hover:text-fg";

function LevelPill({
  label,
  level,
  query,
}: {
  label: string;
  level: JobLevelFilter | null;
  query: JobsBoardQuery;
}) {
  const active = query.level === level;
  return (
    <Link
      href={buildJobsHref({ q: query.q, level })}
      aria-current={active ? "true" : undefined}
      className={`${pillBase} ${active ? pillActive : pillInactive}`}
    >
      {active && <CheckIcon className="h-3.5 w-3.5" />}
      {label}
    </Link>
  );
}

/**
 * Search box + level filter for `/jobs`. All state lives in the URL
 * (`?q=&level=`), so results are shareable and the back button works:
 * - the search is a `next/form` GET form (client-side navigation with
 *   progressive enhancement; a plain form submit without JS);
 * - level pills are links, the active one marked with `aria-current`, a
 *   check icon and a filled style (never color alone).
 *
 * Changing either keeps the other: the form carries `level` as a hidden
 * field and each pill's href carries `q`.
 */
export function JobsSearchControls({ query }: { query: JobsBoardQuery }) {
  return (
    <div className="flex flex-col gap-4">
      <Form
        action="/jobs"
        role="search"
        aria-label="Search jobs"
        className="flex flex-col gap-2 sm:flex-row"
      >
        {query.level && <input type="hidden" name="level" value={query.level} />}
        <div className="relative flex-1">
          <label htmlFor="job-search" className="sr-only">
            Search jobs by title, company, location, or keyword
          </label>
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <input
            // Remount on a new query so the box reflects the URL after
            // "Clear" or back/forward navigation (it's uncontrolled).
            key={query.q ?? ""}
            id="job-search"
            name="q"
            type="search"
            defaultValue={query.q ?? ""}
            placeholder="Search title, company, location, or keyword"
            maxLength={JOBS_SEARCH_MAX_LENGTH}
            autoComplete="off"
            enterKeyHint="search"
            className="w-full rounded-md border border-border-strong bg-surface py-2.5 pl-9 pr-3 text-sm text-fg shadow-sm transition-colors placeholder:text-fg-subtle focus:border-fg-subtle focus:outline-none focus:ring-1 focus:ring-fg-subtle"
          />
        </div>
        <Button type="submit" className="sm:w-auto">
          Search
        </Button>
      </Form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-labelledby="job-level-filter-label"
          className="flex flex-wrap items-center gap-2"
        >
          <span
            id="job-level-filter-label"
            className="mr-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle"
          >
            Level
          </span>
          <LevelPill label="All levels" level={null} query={query} />
          {JOB_LEVEL_FILTERS.map((level) => (
            <LevelPill key={level} label={level} level={level} query={query} />
          ))}
        </div>

        {(query.q || query.level) && (
          <Link
            href={buildJobsHref()}
            className="rounded text-sm font-medium text-fg-muted underline underline-offset-4 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Clear all
          </Link>
        )}
      </div>
    </div>
  );
}
