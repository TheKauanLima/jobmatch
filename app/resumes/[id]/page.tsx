import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { DeleteResumeButton } from "@/components/resumes/DeleteResumeButton";
import { AnalyzeResumeButton } from "@/components/resumes/AnalyzeResumeButton";
import { AnalysisPanel } from "@/components/resumes/AnalysisPanel";
import { RunMatchForm } from "@/components/matches/RunMatchForm";
import { MatchList } from "@/components/matches/MatchList";
import { CritiqueSection } from "@/components/reports/CritiqueSection";
import { RunCritiqueButton } from "@/components/resumes/RunCritiqueButton";
import {
  CRITIQUE_COPY,
  interpretCritiqueLoad,
  type CritiqueLoadResult,
} from "@/lib/client/critique";
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

/**
 * Fetches the latest critique via `GET /api/resumes/:id/critique`
 * (docs/ARCHITECTURE.md §13.20.4). Read-only: opening the page never runs
 * (or charges for) a critique. `404 no_critique` is the empty state.
 */
async function getCritique(id: string): Promise<CritiqueLoadResult> {
  try {
    const response = await serverFetch(`/api/resumes/${id}/critique`);
    return await interpretCritiqueLoad(response);
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
  const [result, critiqueResult, analysisResult, matchesResult, jobDescriptionsResult] =
    await Promise.all([
      getResume(id),
      getCritique(id),
      getAnalysis(id),
      getMatches(id),
      getJobDescriptionsForMatching(),
    ]);

  if (result.kind === "not_found") {
    notFound();
  }

  if (result.kind === "error") {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <Link href="/resumes" className="inline-flex min-h-11 items-center text-sm text-fg-subtle hover:text-fg-muted sm:min-h-0">
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
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <Link
            href="/resumes"
            className="inline-flex min-h-11 items-center text-sm text-fg-subtle hover:text-fg-muted sm:min-h-0"
          >
            &larr; All resumes
          </Link>
          <h1
            title={resume.file_name}
            className="mt-1 break-words text-2xl font-semibold tracking-tight text-fg sm:truncate"
          >
            {resume.file_name}
          </h1>
        </div>
        <DeleteResumeButton
          resumeId={resume.id}
          fileName={resume.file_name}
          redirectTo="/resumes"
        />
      </div>

      <section
        aria-labelledby="resume-critique-heading"
        className="mt-8 rounded-lg border border-border bg-surface p-4 shadow-sm sm:p-6"
      >
        <div className="flex flex-col gap-1">
          <h2 id="resume-critique-heading" className="text-base font-semibold text-fg">
            Resume critique
          </h2>
          <p className="text-sm text-fg-subtle">
            A detailed AI review of this resume. Only you can see it.
          </p>
        </div>
        <div className="mt-5">
          <CritiqueCard resumeId={resume.id} result={critiqueResult} />
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface shadow-sm p-4 sm:p-6">
        <h2 className="text-base font-semibold text-fg">
          File details
        </h2>
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 text-sm min-[22rem]:grid-cols-2">
          <div>
            <dt className="text-fg-subtle">Status</dt>
            <dd className="font-medium text-fg">
              {STATUS_LABELS[resume.status]}
            </dd>
          </div>
          <div>
            <dt className="text-fg-subtle">Type</dt>
            <dd className="break-all font-medium text-fg">{resume.file_type}</dd>
          </div>
          <div>
            <dt className="text-fg-subtle">Size</dt>
            <dd className="font-medium text-fg">
              {formatFileSize(resume.file_size_bytes)}
            </dd>
          </div>
          <div>
            <dt className="text-fg-subtle">Uploaded</dt>
            <dd className="break-words font-medium text-fg">
              {new Date(resume.created_at).toLocaleString()}
            </dd>
          </div>
        </dl>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface shadow-sm p-4 sm:p-6">
        <h2 className="text-base font-semibold text-fg">Resume content</h2>
        <div className="mt-4">
          {resume.extracted_text ? (
            <div className="max-h-[32rem] overflow-y-auto rounded-md border border-border bg-bg p-3 sm:p-4">
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-muted">
                {resume.extracted_text}
              </p>
            </div>
          ) : (
            <p className="text-sm text-fg-subtle">
              No extracted text available for this resume.
            </p>
          )}
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface shadow-sm p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
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

      <section className="mt-6 rounded-lg border border-border bg-surface shadow-sm p-4 sm:p-6">
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

/** Body of the "Resume critique" card for each load state (§13.20.6). */
function CritiqueCard({
  resumeId,
  result,
}: {
  resumeId: string;
  result: CritiqueLoadResult;
}) {
  if (result.kind === "error") {
    return (
      <p
        role="alert"
        className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
      >
        Couldn&apos;t load this resume&apos;s critique. Please refresh the page.
      </p>
    );
  }

  if (result.kind === "none") {
    return (
      <div className="flex flex-col gap-4 rounded-lg border border-dashed border-border-strong bg-bg p-4 sm:p-5">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg">Run your first critique</h3>
          <p className="text-sm leading-relaxed text-fg-muted">
            {CRITIQUE_COPY.emptyDescription}
          </p>
          <p className="text-sm text-fg-subtle">
            {CRITIQUE_COPY.emptyQuota}{" "}
            <Link
              href="/settings"
              className="inline-flex min-h-11 items-center underline underline-offset-2 hover:text-fg-muted sm:min-h-0"
            >
              See your usage
            </Link>
          </p>
        </div>
        <RunCritiqueButton resumeId={resumeId} />
      </div>
    );
  }

  return (
    <CritiqueSection
      critique={result.critique}
      staleAction={
        <RunCritiqueButton
          resumeId={resumeId}
          label={CRITIQUE_COPY.rerunLabel}
          variant="secondary"
        />
      }
    />
  );
}
