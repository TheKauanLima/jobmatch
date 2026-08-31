import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import type { JobDescription } from "@/types/domain";

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
  const result = await getJobDescription(id);

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

      <div className="mt-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          {jobDescription.title}
        </h1>
        {jobDescription.company && (
          <p className="mt-1 text-base text-fg-muted">{jobDescription.company}</p>
        )}
        <p className="mt-1 text-sm text-fg-subtle">
          Submitted {new Date(jobDescription.created_at).toLocaleString()}
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
            View original posting &rarr;
          </a>
        </p>
      )}

      <section className="mt-6 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-base font-semibold text-fg">Description</h2>
        <p className="mt-3 whitespace-pre-wrap text-sm text-fg-muted">
          {jobDescription.description}
        </p>
      </section>
    </div>
  );
}
