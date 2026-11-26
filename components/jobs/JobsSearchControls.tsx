import Form from "next/form";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { JobsFilterSelect } from "@/components/jobs/JobsFilterSelect";
import { JobsSearchInput } from "@/components/jobs/JobsSearchInput";
import {
  buildFieldOptions,
  buildJobsHref,
  buildLocationOptions,
  hasActiveJobsQuery,
  JOB_LEVEL_FILTERS,
  JOBS_SORT_OPTIONS,
  type JobLevelFilter,
  type JobsBoardQuery,
  type JobsFacets,
} from "@/lib/client/jobsBoard";
import { CheckIcon, SearchIcon } from "@/components/jobs/icons";

const pillBase =
  "inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors sm:min-h-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const pillActive = "bg-accent text-accent-fg";
const pillInactive =
  "border border-border-strong bg-surface text-fg-muted hover:bg-surface-hover hover:text-fg";

const filterLabel = "text-xs font-semibold uppercase tracking-wide text-fg-subtle";

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
      href={buildJobsHref({ ...query, level })}
      aria-current={active ? "true" : undefined}
      className={`${pillBase} ${active ? pillActive : pillInactive}`}
    >
      {active && <CheckIcon className="h-3.5 w-3.5" />}
      {label}
    </Link>
  );
}

/**
 * Search box + filter bar for `/jobs` (docs/ARCHITECTURE.md §7.8.7). All
 * state lives in the URL (`?q=&level=&category=&location=&sort=`), so
 * results are shareable and the back button works:
 * - the search is a `next/form` GET form (client-side navigation with
 *   progressive enhancement). It carries the other filters as hidden
 *   fields, so a new search keeps them; an empty search drops `sort`
 *   (`parseJobsSearchParams` keeps `sort` only alongside `q`);
 * - level pills are links, the active one marked with `aria-current`, a
 *   check icon and a filled style (never color alone);
 * - Field, Location and (with a search only) Sort are native selects
 *   (`JobsFilterSelect`) that navigate on change and keep every other param.
 *
 * `facets` drives the options: fields with no listings are disabled, and
 * only states with listings are offered. `null` means the facets request
 * failed: every field is enabled and Location offers only "Any location"
 * and "Remote" (filtering itself still works).
 *
 * Layout: on `sm` and up the filter bar is one wrapping row (labels above
 * controls, bottoms aligned). Below `sm`, the level pills wrap, Field and
 * Location sit in a 2-column grid and Sort spans the full width under them.
 */
export function JobsSearchControls({
  query,
  facets,
}: {
  query: JobsBoardQuery;
  facets: JobsFacets | null;
}) {
  const fieldOptions = buildFieldOptions(facets, query.category);
  const locationOptions = buildLocationOptions(facets, query.location);

  return (
    <div className="flex flex-col gap-5">
      <Form
        action="/jobs"
        role="search"
        aria-label="Search jobs"
        className="flex flex-col gap-2 sm:flex-row"
      >
        {query.level && <input type="hidden" name="level" value={query.level} />}
        {query.category && (
          <input type="hidden" name="category" value={query.category} />
        )}
        {query.location && (
          <input type="hidden" name="location" value={query.location} />
        )}
        {query.sort && <input type="hidden" name="sort" value={query.sort} />}
        <div className="relative flex-1">
          <label htmlFor="job-search" className="sr-only">
            Search jobs by title, company, location, or keyword
          </label>
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          {/* Controlled and synced to the URL without remounting, so focus stays put. */}
          <JobsSearchInput q={query.q} />
        </div>
        <Button type="submit" className="sm:w-auto">
          Search
        </Button>
      </Form>

      <div
        role="group"
        aria-label="Filter jobs"
        className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-5 sm:gap-y-4"
      >
        <div
          role="group"
          aria-labelledby="job-level-filter-label"
          className="flex flex-col gap-1.5"
        >
          <span id="job-level-filter-label" className={filterLabel}>
            Level
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <LevelPill label="All levels" level={null} query={query} />
            {JOB_LEVEL_FILTERS.map((level) => (
              <LevelPill key={level} label={level} level={level} query={query} />
            ))}
          </div>
        </div>

        {/* Mobile: a 2-column grid. sm+: `contents`, so the selects join the row. */}
        <div className="grid grid-cols-2 gap-3 sm:contents">
          <JobsFilterSelect
            key="category"
            param="category"
            label="Field"
            value={query.category ?? ""}
            options={fieldOptions}
            query={query}
            className="sm:w-52 lg:w-60"
          />
          <JobsFilterSelect
            key="location"
            param="location"
            label="Location"
            value={query.location ?? ""}
            options={locationOptions}
            query={query}
            className="sm:w-44 lg:w-48"
          />
          {query.q && (
            <JobsFilterSelect
              key="sort"
              param="sort"
              label="Sort"
              value={query.sort ?? "relevance"}
              options={JOBS_SORT_OPTIONS}
              query={query}
              className="col-span-2 sm:w-40"
            />
          )}
        </div>

        {hasActiveJobsQuery(query) && (
          <Link
            href={buildJobsHref()}
            className="inline-flex min-h-11 items-center self-start rounded text-sm font-medium text-fg-muted underline sm:min-h-0 underline-offset-4 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:ml-auto sm:self-end sm:py-2"
          >
            Clear all
          </Link>
        )}
      </div>
    </div>
  );
}
