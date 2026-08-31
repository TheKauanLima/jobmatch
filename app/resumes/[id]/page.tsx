import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { DeleteResumeButton } from "@/components/resumes/DeleteResumeButton";
import { AnalyzeResumeButton } from "@/components/resumes/AnalyzeResumeButton";
import { AnalysisPanel } from "@/components/resumes/AnalysisPanel";
import { RunMatchForm } from "@/components/matches/RunMatchForm";
import { MatchList } from "@/components/matches/MatchList";
import type {
  JobDescription,
  Match,
  ResumeAnalysis,
  ResumeDetail,
  ResumeStatus,
} from "@/types/domain";

/** First-page size for the job-description picker, per M5 scope (no search UI for v1). */
const MATCH_JOB_DESCRIPTIONS_LIMIT = 50;

const STATUS_LABELS: Record<ResumeStatus, string> = {
  uploaded: "Uploaded",
  processing: "Processing",
  analyzed: "Analyzed",
  failed: "Failed",
};

function formatFileSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1) return "< 1 KB";
  if (kb < 10) return `${kb.toFixed(1)} KB`;
  return `${Math.round(kb)} KB`;
}

type GetResumeResult =
  | { kind: "ok"; resume: ResumeDetail }
  | { kind: "not_found" }
  | { kind: "error" };

async function getResume(id: string): Promise<GetResumeResult> {
  try {
    const response = await serverFetch(`/api/resumes/${id}`);

    if (response.status === 404) {
      return { kind: "not_found" };
    }

    if (!response.ok) {
      return { kind: "error" };
    }

    const body = await response.json();
    if (!body?.resume) {
      return { kind: "error" };
    }

    return { kind: "ok", resume: body.resume };
  } catch {
    return { kind: "error" };
  }
}

type GetAnalysisResult =
  | { kind: "ok"; analysis: ResumeAnalysis }
  | { kind: "none" }
  | { kind: "error" };

/**
 * Fetches the latest analysis via `GET /api/resumes/:id/analysis`. A `404`
 * means no analysis has been run yet — treated as the empty state, not an
 * error (see docs/ARCHITECTURE.md §2).
 *
 * The route contract doesn't show an example response body for this
 * endpoint (unlike `GET /api/resumes/:id`'s documented `{ "resume": ... }`
 * wrapper), so this accepts either `{ "analysis": {...} }` or the row
 * returned directly at the top level — confirm the actual shape with
 * backend-dev once `/api/resumes/:id/analysis` exists.
 */
async function getAnalysis(id: string): Promise<GetAnalysisResult> {
  try {
    const response = await serverFetch(`/api/resumes/${id}/analysis`);

    if (response.status === 404) {
      return { kind: "none" };
    }

    if (!response.ok) {
      return { kind: "error" };
    }

    const body = await response.json();
    const analysis: ResumeAnalysis | undefined =
      body?.analysis ?? (body?.id ? body : undefined);

    if (!analysis) {
      return { kind: "error" };
    }

    return { kind: "ok", analysis };
  } catch {
    return { kind: "error" };
  }
}

type GetMatchesResult =
  | { kind: "ok"; matches: Match[] }
  | { kind: "error" };

/**
 * Fetches this resume's matches via `GET /api/matches?resume_id=:id` (see
 * docs/ARCHITECTURE.md §2). The contract notes "404/empty if not owned by
 * caller" for the ownership case, which can't apply here (this resume's
 * ownership was already confirmed by `getResume` above returning `ok`), so a
 * `404` is treated the same as an empty list rather than an error, matching
 * how `getAnalysis` treats its own 404 case.
 */
async function getMatches(resumeId: string): Promise<GetMatchesResult> {
  try {
    const response = await serverFetch(
      `/api/matches?resume_id=${encodeURIComponent(resumeId)}`,
    );

    if (response.status === 404) {
      return { kind: "ok", matches: [] };
    }

    if (!response.ok) {
      return { kind: "error" };
    }

    const body = await response.json();
    return { kind: "ok", matches: body?.matches ?? [] };
  } catch {
    return { kind: "error" };
  }
}

type GetJobDescriptionsResult =
  | { kind: "ok"; jobDescriptions: JobDescription[] }
  | { kind: "error" };

/**
 * Fetches a first page of shared job descriptions via
 * `GET /api/job-descriptions` (see docs/ARCHITECTURE.md §2) to populate the
 * "match against a job" picker. `MATCH_JOB_DESCRIPTIONS_LIMIT` results, no
 * cursor — v1 doesn't build a search UI for this picker (see
 * `RunMatchForm`'s doc comment).
 */
async function getJobDescriptionsForMatching(): Promise<GetJobDescriptionsResult> {
  try {
    const response = await serverFetch(
      `/api/job-descriptions?limit=${MATCH_JOB_DESCRIPTIONS_LIMIT}`,
    );

    if (!response.ok) {
      return { kind: "error" };
    }

    const body = await response.json();
    return { kind: "ok", jobDescriptions: body?.job_descriptions ?? [] };
  } catch {
    return { kind: "error" };
  }
}

interface ResumeDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ResumeDetailPage({
  params,
}: ResumeDetailPageProps) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;
  const [result, analysisResult, matchesResult, jobDescriptionsResult] =
    await Promise.all([
      getResume(id),
      getAnalysis(id),
      getMatches(id),
      getJobDescriptionsForMatching(),
    ]);

  if (result.kind === "not_found") {
    notFound();
  }

  if (result.kind === "error") {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <Link href="/resumes" className="text-sm text-fg-subtle hover:text-fg-muted">
          &larr; All resumes
        </Link>
        <p
          role="alert"
          className="mt-6 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          Couldn&apos;t load this resume. Please try again.
        </p>
      </div>
    );
  }

  const { resume } = result;
  const analysis = analysisResult.kind === "ok" ? analysisResult.analysis : null;
  const analysisLoadFailed = analysisResult.kind === "error";
  const matches = matchesResult.kind === "ok" ? matchesResult.matches : [];
  const matchesLoadFailed = matchesResult.kind === "error";
  const jobDescriptions =
    jobDescriptionsResult.kind === "ok" ? jobDescriptionsResult.jobDescriptions : [];
  const jobDescriptionsLoadFailed = jobDescriptionsResult.kind === "error";

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/resumes"
            className="text-sm text-fg-subtle hover:text-fg-muted"
          >
            &larr; All resumes
          </Link>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-fg">
            {resume.file_name}
          </h1>
        </div>
        <DeleteResumeButton
          resumeId={resume.id}
          fileName={resume.file_name}
          redirectTo="/resumes"
        />
      </div>

      <section className="mt-8 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-base font-semibold text-fg">
          File details
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt className="text-fg-subtle">Status</dt>
            <dd className="font-medium text-fg">
              {STATUS_LABELS[resume.status]}
            </dd>
          </div>
          <div>
            <dt className="text-fg-subtle">Type</dt>
            <dd className="font-medium text-fg">{resume.file_type}</dd>
          </div>
          <div>
            <dt className="text-fg-subtle">Size</dt>
            <dd className="font-medium text-fg">
              {formatFileSize(resume.file_size_bytes)}
            </dd>
          </div>
          <div>
            <dt className="text-fg-subtle">Uploaded</dt>
            <dd className="font-medium text-fg">
              {new Date(resume.created_at).toLocaleString()}
            </dd>
          </div>
        </dl>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-fg">Analysis</h2>
          <AnalyzeResumeButton resumeId={resume.id} hasAnalysis={!!analysis} />
        </div>
        <div className="mt-4">
          {analysisLoadFailed ? (
            <p
              role="alert"
              className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
            >
              Couldn&apos;t load this resume&apos;s analysis. Please refresh
              the page.
            </p>
          ) : (
            <AnalysisPanel analysis={analysis} />
          )}
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-base font-semibold text-fg">Matches</h2>
        <div className="mt-4">
          {!analysis ? (
            <p className="text-sm text-fg-muted">
              Analyze this resume first to unlock matching against job
              descriptions.
            </p>
          ) : (
            <>
              {jobDescriptionsLoadFailed ? (
                <p
                  role="alert"
                  className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
                >
                  Couldn&apos;t load job descriptions to match against.
                  Please refresh the page.
                </p>
              ) : (
                <RunMatchForm
                  resumeId={resume.id}
                  jobDescriptions={jobDescriptions}
                />
              )}

              <div className="mt-6">
                {matchesLoadFailed ? (
                  <p
                    role="alert"
                    className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
                  >
                    Couldn&apos;t load this resume&apos;s matches. Please
                    refresh the page.
                  </p>
                ) : (
                  <MatchList matches={matches} />
                )}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
