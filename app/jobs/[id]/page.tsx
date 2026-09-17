import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { MatchFromJobForm } from "@/components/matches/MatchFromJobForm";
import { EditJobDescriptionForm } from "@/components/jobs/EditJobDescriptionForm";
import { DeleteJobDescriptionButton } from "@/components/jobs/DeleteJobDescriptionButton";
import type { JobDescription, ResumeListItem } from "@/types/domain";

type GetJobDescriptionResult =
  | { kind: "ok"; jobDescription: JobDescription }
  | { kind: "not_found" }
  | { kind: "error" };

async function getJobDescription(id: string): Promise<GetJobDescriptionResult> {
  try {
    const response = await serverFetch(`/api/job-descriptions/${id}`);

    if (response.status === 404) {
      return { kind: "not_found" };
    }

    if (!response.ok) {
      return { kind: "error" };
    }

    const body = await response.json();
    if (!body?.job_description) {
      return { kind: "error" };
    }

    return { kind: "ok", jobDescription: body.job_description };
  } catch {
    return { kind: "error" };
  }
}

type GetAnalyzedResumesResult =
  | { kind: "ok"; resumes: ResumeListItem[] }
  | { kind: "error" };

/**
 * Fetches the caller's own analyzed resumes to populate `MatchFromJobForm`'s
 * picker — added per the 2026-09-10 UX pass so a student can start a match
 * directly from a job listing instead of only from `/resumes/[id]`. Filters
 * to `status === "analyzed"` client-side (same proxy `AnalyzeResumeButton`
 * already uses for "has an analysis") since `GET /api/resumes` doesn't have
 * a status filter of its own — the caller's resume count is small enough
 * (v1 has no per-user cap, but realistically dozens at most) that filtering
 * the full list here is simpler than adding one.
 */
async function getAnalyzedResumes(): Promise<GetAnalyzedResumesResult> {
  try {
    const response = await serverFetch("/api/resumes");

    if (!response.ok) {
      return { kind: "error" };
    }

    const body = await response.json();
    const resumes: ResumeListItem[] = body?.resumes ?? [];
    return {
      kind: "ok",
      resumes: resumes.filter((resume) => resume.status === "analyzed"),
    };
  } catch {
    return { kind: "error" };
  }
}

interface JobDescriptionDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function JobDescriptionDetailPage({
  params,
}: JobDescriptionDetailPageProps) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;
  const [result, analyzedResumesResult] = await Promise.all([
    getJobDescription(id),
    getAnalyzedResumes(),
  ]);

  if (result.kind === "not_found") {
    notFound();
  }

  if (result.kind === "error") {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <Link href="/jobs" className="text-sm text-fg-subtle hover:text-fg-muted">
          &larr; All job descriptions
        </Link>
        <p
          role="alert"
          className="mt-6 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          Couldn&apos;t load this job description. Please try again.
        </p>
      </div>
    );
  }

  const { jobDescription } = result;

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <Link href="/jobs" className="text-sm text-fg-subtle hover:text-fg-muted">
        &larr; All job descriptions
      </Link>

      <div className="mt-1 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            {jobDescription.title}
          </h1>
          {jobDescription.company && (
            <p className="mt-1 text-base text-fg-muted">{jobDescription.company}</p>
          )}
        </div>
        {jobDescription.is_own && (
          <DeleteJobDescriptionButton
            jobDescriptionId={jobDescription.id}
            title={jobDescription.title}
            className="shrink-0"
          />
        )}
      </div>

      <div className="mt-1">
        {jobDescription.deleted_at && (
          <p
            role="status"
            className="mt-4 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg"
          >
            {jobDescription.is_own
              ? "You removed this posting."
              : "This posting has been removed."}
          </p>
        )}

        {(jobDescription.level || jobDescription.location) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {jobDescription.level && (
              <span className="rounded-full bg-neutral-bg px-2 py-0.5 text-xs font-medium text-neutral-fg">
                {jobDescription.level}
              </span>
            )}
            {jobDescription.location && (
              <span className="text-xs text-fg-subtle">
                {jobDescription.location}
              </span>
            )}
          </div>
        )}

        <p className="mt-2 text-sm text-fg-subtle">
          {jobDescription.source === "themuse"
            ? `Posted ${new Date(
                jobDescription.posted_at ?? jobDescription.created_at,
              ).toLocaleDateString()} · via The Muse`
            : `Submitted ${new Date(jobDescription.created_at).toLocaleString()}`}
        </p>
      </div>

      {jobDescription.source_url && (
        <p className="mt-4 text-sm">
          <a
            href={jobDescription.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg-muted underline hover:text-fg"
          >
            {jobDescription.source === "themuse"
              ? "Apply on The Muse"
              : "View original posting"}{" "}
            &rarr;
          </a>
        </p>
      )}

      <section className="mt-6 rounded-lg border border-border bg-surface shadow-sm p-6">
        <h2 className="text-base font-semibold text-fg">Description</h2>
        <p className="mt-3 whitespace-pre-wrap text-sm text-fg-muted">
          {jobDescription.description}
        </p>
      </section>

      {jobDescription.is_own && (
        <div className="mt-6">
          <EditJobDescriptionForm jobDescription={jobDescription} />
        </div>
      )}

      {!jobDescription.deleted_at && (
        <section className="mt-6 rounded-lg border border-border bg-surface shadow-sm p-6">
          <h2 className="text-base font-semibold text-fg">
            Match against your resume
          </h2>
          <div className="mt-4">
            {analyzedResumesResult.kind === "error" ? (
              <p
                role="alert"
                className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
              >
                Couldn&apos;t load your resumes. Please refresh the page.
              </p>
            ) : (
              <MatchFromJobForm
                jobDescriptionId={jobDescription.id}
                analyzedResumes={analyzedResumesResult.resumes}
              />
            )}
          </div>
        </section>
      )}
    </div>
  );
}
