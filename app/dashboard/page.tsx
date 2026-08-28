import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function DashboardPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const { user } = session;

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
          <h2 className="text-base font-semibold text-zinc-900">
            Your resumes
          </h2>
          <p className="mt-2 text-sm text-zinc-600">
            You haven&apos;t uploaded a resume yet. Upload one to get an
            AI-powered strengths/weaknesses breakdown.
          </p>
          <span className="mt-4 inline-block cursor-default rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-400">
            Upload a resume (coming soon)
          </span>
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
