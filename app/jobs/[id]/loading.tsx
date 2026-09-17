import { Skeleton } from "@/components/ui/Skeleton";

/** Route-level loading UI for `/jobs/[id]` — see `components/ui/Skeleton.tsx`. */
export default function JobDescriptionDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <Skeleton className="h-4 w-36" />
      <Skeleton className="mt-3 h-8 w-72 max-w-full" />
      <Skeleton className="mt-2 h-5 w-40" />

      <div className="mt-6 rounded-lg border border-border bg-surface shadow-sm p-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="mt-3 h-32 w-full" />
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface shadow-sm p-6">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-4 h-10 w-full" />
      </div>
    </div>
  );
}
