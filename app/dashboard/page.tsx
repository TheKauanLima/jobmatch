import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { ResumeCard } from "@/components/resumes/ResumeCard";
import { JobDescriptionCard } from "@/components/jobs/JobDescriptionCard";
import { RecentMatchCard } from "@/components/matches/RecentMatchCard";
import type { JobDescription, RecentMatch, ResumeListItem } from "@/types/domain";

const RECENT_RESUMES_LIMIT = 3;
const LATEST_JOB_DESCRIPTIONS_LIMIT = 3;
const RECENT_MATCHES_LIMIT = 3;

async function getRecentResumes(): Promise<{
  resumes: ResumeListItem[];
  error: string | null;
}> {
  try {
    const response = await serverFetch("/api/resumes");

    if (!response.ok) {
      return { resumes: [], error: "Couldn't load your resumes." };
    }

    const body = await response.json();
    const resumes: ResumeListItem[] = body.resumes ?? [];
    return { resumes: resumes.slice(0, RECENT_RESUMES_LIMIT), error: null };
  } catch {
    return { resumes: [], error: "Couldn't load your resumes." };
  }
}

/**
 * Fetches the newest few shared job listings for the dashboard teaser — per
 * docs/ARCHITECTURE.md §7, this is the most direct way for a returning user
 * to see that the board now has real, continually-refreshed content (a mix
 * of user-submitted and externally-ingested rows, most-recent-first via the
 * default `GET /api/job-descriptions` ordering), not just an empty "browse
 * jobs" link.
 */
async function getLatestJobDescriptions(): Promise<{
  jobDescriptions: JobDescription[];
  error: string | null;
}> {
  try {
    const response = await serverFetch(
      `/api/job-descriptions?limit=${LATEST_JOB_DESCRIPTIONS_LIMIT}`,
    );

    if (!response.ok) {
      return { jobDescriptions: [], error: "Couldn't load job listings." };
    }

    const body = await response.json();
    return { jobDescriptions: body.job_descriptions ?? [], error: null };
  } catch {
    return { jobDescriptions: [], error: "Couldn't load job listings." };
  }
}

/**
 * Fetches the caller's own most recent matches across all resumes via
 * `GET /api/matches` (no `resume_id` — see that route's docstring and
 * docs/ARCHITECTURE.md §2) for the dashboard's "Latest matches" panel. This
 * replaced a previously hardcoded "No matches yet" placeholder that never
 * reflected real data regardless of whether the user actually had matches.
 */
async function getRecentMatches(): Promise<{
  matches: RecentMatch[];
  error: string | null;
}> {
  try {
    const response = await serverFetch(
      `/api/matches?limit=${RECENT_MATCHES_LIMIT}`,
    );

    if (!response.ok) {
      return { matches: [], error: "Couldn't load your matches." };
    }

    const body = await response.json();
    return { matches: body.matches ?? [], error: null };
  } catch {
    return { matches: [], error: "Couldn't load your matches." };
  }
}

export default async function DashboardPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const { user } = session;
  const [
    { resumes, error },
    { jobDescriptions, error: jobDescriptionsError },
    { matches, error: matchesError },
  ] = await Promise.all([
    getRecentResumes(),
    getLatestJobDescriptions(),
    getRecentMatches(),
  ]);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Welcome back{user.email ? `, ${user.email}` : ""}
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        Here&apos;s an overview of your resumes and recent matches.
      </p>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        <section className="rounded-lg border border-border bg-surface p-6">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-base font-semibold text-fg">
              Your resumes
            </h2>
            <Link
              href="/resumes"
              className="text-sm font-medium text-fg-muted hover:text-fg"
            >
              View all
            </Link>
          </div>

          {error ? (
            <p
              role="alert"
              className="mt-3 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
            >
              {error}
            </p>
          ) : resumes.length === 0 ? (
            <>
              <p className="mt-2 text-sm text-fg-muted">
                You haven&apos;t uploaded a resume yet. Upload one to get an
                AI-powered strengths/weaknesses breakdown.
              </p>
              <Link
                href="/resumes"
                className="mt-4 inline-block rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
              >
                Upload a resume
              </Link>
            </>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              {resumes.map((resume) => (
                <ResumeCard key={resume.id} resume={resume} />
              ))}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border bg-surface p-6">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-base font-semibold text-fg">
              Recent matches
            </h2>
            <Link
              href="/matches"
              className="text-sm font-medium text-fg-muted hover:text-fg"
            >
              View all matches &rarr;
            </Link>
          </div>

          {matchesError ? (
            <p
              role="alert"
              className="mt-3 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
            >
              {matchesError}
            </p>
          ) : matches.length === 0 ? (
            <p className="mt-2 text-sm text-fg-muted">
              No matches yet. Once you&apos;ve uploaded and analyzed a resume,
              match it against a job description to see how it stacks up.
            </p>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              {matches.map((match) => (
                <RecentMatchCard key={match.id} match={match} />
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="mt-6 rounded-lg border border-border bg-surface p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-fg">
            Latest job listings
          </h2>
          <Link
            href="/jobs"
            className="text-sm font-medium text-fg-muted hover:text-fg"
          >
            View all
          </Link>
        </div>

        {jobDescriptionsError ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
          >
            {jobDescriptionsError}
          </p>
        ) : jobDescriptions.length === 0 ? (
          <p className="mt-2 text-sm text-fg-muted">
            No job listings yet. Check back soon, or submit one yourself.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {jobDescriptions.map((jobDescription) => (
              <JobDescriptionCard
                key={jobDescription.id}
                jobDescription={jobDescription}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
