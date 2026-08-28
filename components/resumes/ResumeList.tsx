import type { ResumeListItem } from "@/types/domain";
import { ResumeCard } from "@/components/resumes/ResumeCard";

interface ResumeListProps {
  resumes: ResumeListItem[];
}

/** Renders a list of resumes, or an empty state prompting the user to upload one. */
export function ResumeList({ resumes }: ResumeListProps) {
  if (resumes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center">
        <p className="text-sm text-zinc-600">
          No resumes yet. Upload one above to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {resumes.map((resume) => (
        <ResumeCard key={resume.id} resume={resume} />
      ))}
    </div>
  );
}
