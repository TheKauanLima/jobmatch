import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { MatchFromJobForm } from "@/components/matches/MatchFromJobForm";
import { JobDetailErrorState, JobDetailView } from "@/components/jobs/JobDetail";
import { JobOwnerTools } from "@/components/jobs/JobOwnerTools";
import type { JobDescription, ResumeListItem } from "@/types/domain";

export const metadata: Metadata = {
  title: "Job details · Kalify",
};

type GetJobDescriptionResult =
  | { kind: "ok"; jobDescription: JobDescription }
  | { kind: "not_found" }
  | { kind: "error" };

async function getJobDescription(id: string): Promise<GetJobDescriptionResult> {
  try {
    const response = await serverFetch(
      `/api/job-descriptions/${encodeURIComponent(id)}`,
    );

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
 * The caller's own analyzed resumes, for `MatchFromJobForm`'s picker (added
 * in the 2026-09-10 UX pass so a match can start from a listing). `GET
 * /api/resumes` is owner-scoped by the API and RLS, so this only ever
 * returns the signed-in user's resumes; filtered to `status === "analyzed"`
 * client-side since that route has no status filter.
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
    return <JobDetailErrorState id={id} />;
  }

  const { jobDescription } = result;
  const canMatch =
    analyzedResumesResult.kind === "ok" &&
    analyzedResumesResult.resumes.length > 0;

  const matchSection = jobDescription.deleted_at ? null : analyzedResumesResult.kind ===
    "error" ? (
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
  );

  return (
    <JobDetailView
      job={jobDescription}
      canMatch={canMatch}
      matchSection={matchSection}
      ownerTools={
        jobDescription.is_own ? <JobOwnerTools job={jobDescription} /> : undefined
      }
    />
  );
}
