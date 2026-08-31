import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { JobDescriptionForm } from "@/components/jobs/JobDescriptionForm";
import { JobDescriptionList } from "@/components/jobs/JobDescriptionList";
import type { JobDescription } from "@/types/domain";

async function getJobDescriptions(): Promise<{
  jobDescriptions: JobDescription[];
  nextCursor: string | null;
  error: string | null;
}> {
  try {
    const response = await serverFetch("/api/job-descriptions");

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

export default async function JobsPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const { jobDescriptions, nextCursor, error } = await getJobDescriptions();

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Job descriptions
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        Shared across every JobMatch user — submit a posting so anyone can
        match their resume against it, and browse what others have added.
      </p>

      <div className="mt-8">
        <JobDescriptionForm />
      </div>

      <div className="mt-8">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
          >
            {error}
          </p>
        ) : (
          <JobDescriptionList
            initialJobDescriptions={jobDescriptions}
            initialNextCursor={nextCursor}
          />
        )}
      </div>
    </div>
  );
}
