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
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        Welcome back{user.email ? `, ${user.email}` : ""}
      </h1>
      <p className="mt-2 text-sm text-zinc-600">
        Here&apos;s an overview of your resumes and recent matches.
      </p>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        <section className="rounded-lg border border-zinc-200 bg-white p-6">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-base font-semibold text-zinc-900">
              Your resumes
            </h2>
            <Link
              href="/resumes"
              className="text-sm font-medium text-zinc-600 hover:text-zinc-900"
            >
              View all
            </Link>
          </div>

          {error ? (
            <p
              role="alert"
              className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </p>
          ) : resumes.length === 0 ? (
            <>
              <p className="mt-2 text-sm text-zinc-600">
                You haven&apos;t uploaded a resume yet. Upload one to get an
                AI-powered strengths/weaknesses breakdown.
              </p>
              <Link
                href="/resumes"
                className="mt-4 inline-block rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
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

        <section className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="text-base font-semibold text-zinc-900">
            Recent matches
          </h2>
          <p className="mt-2 text-sm text-zinc-600">
            No matches yet. Once you&apos;ve uploaded and analyzed a resume,
            match it against a job description to see how it stacks up.
          </p>
        </section>
      </div>
    </div>
  );
}
