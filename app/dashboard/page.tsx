import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { ResumeCard } from "@/components/resumes/ResumeCard";
import type { ResumeListItem } from "@/types/domain";

const RECENT_RESUMES_LIMIT = 3;

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

export default async function DashboardPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const { user } = session;
  const { resumes, error } = await getRecentResumes();

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
          <h2 className="text-base font-semibold text-fg">
            Recent matches
          </h2>
          <p className="mt-2 text-sm text-fg-muted">
            No matches yet. Once you&apos;ve uploaded and analyzed a resume,
            match it against a job description to see how it stacks up.
          </p>
        </section>
      </div>
    </div>
  );
}
