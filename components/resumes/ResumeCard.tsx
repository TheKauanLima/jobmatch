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
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="min-w-0">
        <Link
          href={`/resumes/${resume.id}`}
          className="truncate text-sm font-medium text-fg hover:underline"
        >
          {resume.file_name}
        </Link>
        <div className="mt-1 flex items-center gap-2">
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
          className="rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium text-fg-muted transition-colors hover:bg-surface-hover"
        >
          View
        </Link>
        <DeleteResumeButton resumeId={resume.id} fileName={resume.file_name} />
      </div>
    </div>
  );
}
