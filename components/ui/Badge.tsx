import type { ReactNode } from "react";

interface BadgeProps {
  children: ReactNode;
  className?: string;
}

/**
 * Small pill label using the shared `neutral-*` tokens
 * (docs/ARCHITECTURE.md §6.1) — e.g. the "Removed" badge next to a
 * soft-deleted job description's title in `MatchList`/`RecentMatchCard`/
 * `MatchHistoryList` (§10.5/§11.2).
 *
 * Did not exist before this change — §10.5/§11.2 call for "reusing
 * `components/ui/Badge`" as if it already existed, but the only prior
 * instance of this exact visual (`rounded-full bg-neutral-bg px-2 py-0.5
 * text-xs font-medium text-neutral-fg`) was inlined directly in
 * `JobDescriptionCard`'s level tag, not a shared component. Extracted here
 * per the doc's intent rather than re-inlining a third copy; left
 * `JobDescriptionCard`'s existing inline instance alone (out of scope for
 * this change) rather than refactoring unrelated code.
 */
export function Badge({ children, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full bg-neutral-bg px-2 py-0.5 text-xs font-medium text-neutral-fg ${className}`}
    >
      {children}
    </span>
  );
}
