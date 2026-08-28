import Link from "next/link";
import type { ResumeListItem } from "@/types/domain";
import { DeleteResumeButton } from "@/components/resumes/DeleteResumeButton";

const STATUS_LABELS: Record<ResumeListItem["status"], string> = {
  uploaded: "Uploaded",
  processing: "Processing",
  analyzed: "Analyzed",
  failed: "Failed",
};

const STATUS_STYLES: Record<ResumeListItem["status"], string> = {
  uploaded: "bg-zinc-100 text-zinc-700",
  processing: "bg-amber-100 text-amber-800",
  analyzed: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-700",
};

interface ResumeCardProps {
  resume: ResumeListItem;
}

/** Compact display of one resume: name, status, date, view + delete actions. */
export function ResumeCard({ resume }: ResumeCardProps) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="min-w-0">
        <Link
          href={`/resumes/${resume.id}`}
          className="truncate text-sm font-medium text-zinc-900 hover:underline"
        >
          {resume.file_name}
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[resume.status]}`}
          >
            {STATUS_LABELS[resume.status]}
          </span>
          <span className="text-xs text-zinc-500">
            Uploaded {new Date(resume.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Link
          href={`/resumes/${resume.id}`}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
        >
          View
        </Link>
        <DeleteResumeButton resumeId={resume.id} fileName={resume.file_name} />
      </div>
    </div>
  );
}
