import { Badge } from "@/components/ui/Badge";
import { getJobSourceInfo } from "@/lib/client/jobsBoard";
import { jobCategoryLabel } from "@/lib/jobs/categories";

/**
 * Level tag (e.g. "Internship"), using the shared `Badge`. Text label, so the
 * level is never conveyed by color alone.
 */
export function JobLevelBadge({ level }: { level: string }) {
  return (
    <Badge>
      <span className="sr-only">Level: </span>
      {level}
    </Badge>
  );
}

/**
 * Field tag (e.g. "Data & AI"; docs/ARCHITECTURE.md §7.8.7), neutral like the
 * level tag. Renders nothing while the field isn't computed yet (`null`) or
 * for the "Other" fallback, which wouldn't tell the reader anything.
 */
export function JobFieldBadge({ category }: { category: string | null }) {
  if (category === "other") return null;
  const label = jobCategoryLabel(category);
  if (!label) return null;
  return (
    <Badge>
      <span className="sr-only">Field: </span>
      {label}
    </Badge>
  );
}

/**
 * Where a listing came from: "Community" (user-submitted) or the external
 * board's name. Outlined rather than filled so it reads as secondary to the
 * level tag; the hover title and screen-reader prefix spell out the meaning.
 */
export function JobSourceBadge({ source }: { source: string }) {
  const info = getJobSourceInfo(source);
  return (
    <span
      title={info.description}
      className="inline-flex shrink-0 items-center rounded-full border border-border-strong px-2 py-0.5 text-xs font-medium text-fg-muted"
    >
      <span className="sr-only">Source: </span>
      {info.label}
    </span>
  );
}

/** Marks the caller's own submission (`is_own`). */
export function OwnPostingBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-success-border bg-success-bg px-2 py-0.5 text-xs font-medium text-success-fg">
      Your posting
    </span>
  );
}
