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
  uploaded: "bg-neutral-bg text-neutral-fg",
  processing: "bg-warning-bg text-warning-fg",
  analyzed: "bg-success-bg text-success-fg",
  failed: "bg-danger-bg text-danger-fg",
};

interface ResumeCardProps {
  resume: ResumeListItem;
}

/** Compact display of one resume: name, status, date, view + delete actions. */
export function ResumeCard({ resume }: ResumeCardProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-lg border border-border bg-surface p-4 shadow-sm">
      {/* Wraps the actions onto their own row only when the name gets too narrow (~360px and below). */}
      <div className="min-w-0 flex-1 basis-40">
        <Link
          href={`/resumes/${resume.id}`}
          title={resume.file_name}
          className="block truncate text-sm font-medium text-fg hover:underline"
        >
          {resume.file_name}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[resume.status]}`}
          >
            {STATUS_LABELS[resume.status]}
          </span>
          <span className="text-xs text-fg-subtle">
            Uploaded {new Date(resume.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Link
          href={`/resumes/${resume.id}`}
          className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium text-fg-muted transition-colors hover:bg-surface-hover sm:min-h-0"
        >
          View
        </Link>
        <DeleteResumeButton resumeId={resume.id} fileName={resume.file_name} />
      </div>
    </div>
  );
}
