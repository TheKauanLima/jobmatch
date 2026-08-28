import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { DeleteResumeButton } from "@/components/resumes/DeleteResumeButton";
import { AnalyzeResumeButton } from "@/components/resumes/AnalyzeResumeButton";
import { AnalysisPanel } from "@/components/resumes/AnalysisPanel";
import type { ResumeAnalysis, ResumeDetail, ResumeStatus } from "@/types/domain";

const STATUS_LABELS: Record<ResumeStatus, string> = {
  uploaded: "Uploaded",
  processing: "Processing",
  analyzed: "Analyzed",
  failed: "Failed",
};

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
  const [result, analysisResult] = await Promise.all([
    getResume(id),
    getAnalysis(id),
  ]);

  if (result.kind === "not_found") {
    notFound();
  }

  if (result.kind === "error") {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <Link href="/resumes" className="text-sm text-zinc-500 hover:text-zinc-700">
          &larr; All resumes
        </Link>
        <p
          role="alert"
          className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          Couldn&apos;t load this resume. Please try again.
        </p>
      </div>
    );
  }

  const { resume } = result;
  const analysis = analysisResult.kind === "ok" ? analysisResult.analysis : null;
  const analysisLoadFailed = analysisResult.kind === "error";

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/resumes"
            className="text-sm text-zinc-500 hover:text-zinc-700"
          >
            &larr; All resumes
          </Link>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-zinc-900">
            {resume.file_name}
          </h1>
        </div>
        <DeleteResumeButton
          resumeId={resume.id}
          fileName={resume.file_name}
          redirectTo="/resumes"
        />
      </div>

      <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-6">
        <h2 className="text-base font-semibold text-zinc-900">
          File details
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt className="text-zinc-500">Status</dt>
            <dd className="font-medium text-zinc-900">
              {STATUS_LABELS[resume.status]}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Type</dt>
            <dd className="font-medium text-zinc-900">{resume.file_type}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Size</dt>
            <dd className="font-medium text-zinc-900">
              {(resume.file_size_bytes / 1024).toFixed(0)} KB
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Uploaded</dt>
            <dd className="font-medium text-zinc-900">
              {new Date(resume.created_at).toLocaleString()}
            </dd>
          </div>
        </dl>
      </section>

      <section className="mt-6 rounded-lg border border-zinc-200 bg-white p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-zinc-900">Analysis</h2>
          <AnalyzeResumeButton resumeId={resume.id} hasAnalysis={!!analysis} />
        </div>
        <div className="mt-4">
          {analysisLoadFailed ? (
            <p
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              Couldn&apos;t load this resume&apos;s analysis. Please refresh
              the page.
            </p>
          ) : (
            <AnalysisPanel analysis={analysis} />
          )}
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-zinc-200 bg-white p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-zinc-900">Matches</h2>
          <span className="shrink-0 cursor-default rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-400">
            Match against a job (coming soon)
          </span>
        </div>
        <p className="mt-2 text-sm text-zinc-600">
          No matches yet. Once this resume is analyzed, match it against a
          job description to see how it stacks up.
        </p>
      </section>
    </div>
  );
}
