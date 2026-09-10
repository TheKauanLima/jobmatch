interface SkeletonProps {
  className?: string;
}

/**
 * Generic pulsing placeholder block, used to build per-route `loading.tsx`
 * skeletons (see `app/*\/loading.tsx`) — added per the 2026-09-10 UX pass:
 * every route previously had no `loading.tsx` at all, so Next.js showed
 * nothing (a blank/stale previous page) for the full duration of each page's
 * server-side data fetching. `bg-neutral-bg` keeps it theme-aware (light and
 * dark) without a new token.
 */
export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-neutral-bg ${className}`}
    />
  );
}
