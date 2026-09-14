import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { JobDescriptionForm } from "@/components/jobs/JobDescriptionForm";
import { JobDescriptionList } from "@/components/jobs/JobDescriptionList";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import type { JobDescription } from "@/types/domain";

/**
 * Levels the level-filter pills offer, per docs/ARCHITECTURE.md §7 — these
 * match `THEMUSE_SYNC_LEVELS` (`lib/jobs/themuse.ts`), the only levels the
 * external sync ever populates. Not derived from that constant directly to
 * avoid a client-bundle import of `lib/jobs/themuse.ts` (which pulls in the
 * Muse API client) into this page just for two strings.
 */
const JOB_LEVEL_FILTERS = ["Internship", "Entry Level"] as const;

async function getJobDescriptions(
  level: string | null,
  q: string | null,
): Promise<{
  jobDescriptions: JobDescription[];
  nextCursor: string | null;
  error: string | null;
}> {
  try {
    const params = new URLSearchParams();
    if (level) params.set("level", level);
    if (q) params.set("q", q);
    const query = params.toString();
    const path = query
      ? `/api/job-descriptions?${query}`
      : "/api/job-descriptions";
    const response = await serverFetch(path);

    if (!response.ok) {
      return {
        jobDescriptions: [],
        nextCursor: null,
        error: "Couldn't load job descriptions. Please try refreshing the page.",
      };
    }

    const body = await response.json();
    return {
      jobDescriptions: body.job_descriptions ?? [],
      nextCursor: body.next_cursor ?? null,
      error: null,
    };
  } catch {
    return {
      jobDescriptions: [],
      nextCursor: null,
      error: "Couldn't load job descriptions. Please try refreshing the page.",
    };
  }
}

interface JobsPageProps {
  searchParams: Promise<{ level?: string; q?: string }>;
}

export default async function JobsPage({ searchParams }: JobsPageProps) {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const { level: rawLevel, q: rawQ } = await searchParams;
  const level =
    rawLevel && JOB_LEVEL_FILTERS.includes(rawLevel as (typeof JOB_LEVEL_FILTERS)[number])
      ? rawLevel
      : null;
  const q = rawQ?.trim() ? rawQ.trim() : null;

  const { jobDescriptions, nextCursor, error } = await getJobDescriptions(level, q);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Job descriptions
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        Shared across every JobMatch user — a mix of postings the community
        has submitted and internship/entry-level listings JobMatch pulls in
        automatically from The Muse. Submit your own below, or browse and
        match your resume against what&apos;s here.
      </p>

      <div className="mt-8">
        <JobDescriptionForm />
      </div>

      <form action="/jobs" method="get" className="mt-8 flex gap-2">
        {level && <input type="hidden" name="level" value={level} />}
        <div className="flex-1">
          <Input
            id="job-search"
            label="Search"
            name="q"
            type="search"
            defaultValue={q ?? ""}
            placeholder="Search by title, company, or keyword…"
            maxLength={200}
          />
        </div>
        <Button type="submit" className="self-end">
          Search
        </Button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link
          href={q ? `/jobs?q=${encodeURIComponent(q)}` : "/jobs"}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            level === null
              ? "bg-accent text-accent-fg"
              : "bg-neutral-bg text-neutral-fg hover:bg-surface-hover"
          }`}
        >
          All
        </Link>
        {JOB_LEVEL_FILTERS.map((filterLevel) => {
          const params = new URLSearchParams({ level: filterLevel });
          if (q) params.set("q", q);
          return (
            <Link
              key={filterLevel}
              href={`/jobs?${params.toString()}`}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                level === filterLevel
                  ? "bg-accent text-accent-fg"
                  : "bg-neutral-bg text-neutral-fg hover:bg-surface-hover"
              }`}
            >
              {filterLevel}
            </Link>
          );
        })}
      </div>

      <div className="mt-4">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
          >
            {error}
          </p>
        ) : (
          <JobDescriptionList
            key={`${level ?? "all"}:${q ?? ""}`}
            initialJobDescriptions={jobDescriptions}
            initialNextCursor={nextCursor}
            level={level}
            q={q}
          />
        )}
      </div>
    </div>
  );
}
