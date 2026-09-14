import Link from "next/link";
import type { JobDescription } from "@/types/domain";

const PREVIEW_LENGTH = 180;

function previewText(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length <= PREVIEW_LENGTH) return trimmed;
  return `${trimmed.slice(0, PREVIEW_LENGTH).trimEnd()}…`;
}

interface JobDescriptionCardProps {
  jobDescription: JobDescription;
}

/**
 * Compact display of one job description: title, company, level/location
 * tags, preview, date. `level` and `location` (added per
 * docs/ARCHITECTURE.md §7) are only populated for externally-ingested
 * listings in v1 — rendered conditionally so user-submitted rows (which
 * never set either) look exactly as before.
 */
export function JobDescriptionCard({ jobDescription }: JobDescriptionCardProps) {
  return (
    <Link
      href={`/jobs/${jobDescription.id}`}
      className="block rounded-lg border border-border bg-surface p-4 transition-colors hover:bg-surface-hover"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-fg">
            {jobDescription.title}
          </h3>
          {jobDescription.company && (
            <p className="mt-0.5 truncate text-sm text-fg-muted">
              {jobDescription.company}
            </p>
          )}
        </div>
        <span className="shrink-0 text-xs text-fg-subtle">
          {new Date(jobDescription.created_at).toLocaleDateString()}
        </span>
      </div>

      {(jobDescription.level || jobDescription.location) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {jobDescription.level && (
            <span className="rounded-full bg-neutral-bg px-2 py-0.5 text-xs font-medium text-neutral-fg">
              {jobDescription.level}
            </span>
          )}
          {jobDescription.location && (
            <span className="text-xs text-fg-subtle">
              {jobDescription.location}
            </span>
          )}
        </div>
      )}

      <p className="mt-2 text-sm text-fg-muted">
        {previewText(jobDescription.description)}
      </p>
    </Link>
  );
}
