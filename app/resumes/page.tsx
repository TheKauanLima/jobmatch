import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { ResumeUploadForm } from "@/components/resumes/ResumeUploadForm";
import { ResumeList } from "@/components/resumes/ResumeList";
import type { ResumeListItem } from "@/types/domain";

async function getResumes(): Promise<{
  resumes: ResumeListItem[];
  error: string | null;
}> {
  try {
    const response = await serverFetch("/api/resumes");

    if (!response.ok) {
      return {
        resumes: [],
        error: "Couldn't load your resumes. Please try refreshing the page.",
      };
    }

    const body = await response.json();
    return { resumes: body.resumes ?? [], error: null };
  } catch {
    return {
      resumes: [],
      error: "Couldn't load your resumes. Please try refreshing the page.",
    };
  }
}

export default async function ResumesPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const { resumes, error } = await getResumes();

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        Your resumes
      </h1>
      <p className="mt-2 text-sm text-zinc-600">
        Upload a resume to get an AI-powered strengths/weaknesses breakdown
        and match it against job descriptions.
      </p>

      <div className="mt-8">
        <ResumeUploadForm />
      </div>

      <div className="mt-8">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        ) : (
          <ResumeList resumes={resumes} />
        )}
      </div>
    </div>
  );
}
