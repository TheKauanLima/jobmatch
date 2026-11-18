import { Skeleton } from "@/components/ui/Skeleton";

/** Route-level loading UI for `/resumes/[id]` — see `components/ui/Skeleton.tsx`. */
export default function ResumeDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-3 h-8 w-64 max-w-full" />

      {/* Resume critique card (§13.20.6): score ring + summary, then a few rows. */}
      <div className="mt-8 rounded-lg border border-border bg-surface p-4 shadow-sm sm:p-6">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="mt-2 h-4 w-64 max-w-full" />
        <div className="mt-5 flex flex-col gap-5 rounded-lg border border-border p-4 sm:flex-row sm:items-center">
          <Skeleton className="h-24 w-24 shrink-0 rounded-full sm:h-28 sm:w-28" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
        <Skeleton className="mt-6 h-4 w-32" />
        <Skeleton className="mt-3 h-14 w-full" />
        <Skeleton className="mt-3 h-14 w-full" />
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface shadow-sm p-6">
        <Skeleton className="h-5 w-28" />
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface shadow-sm p-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="mt-4 h-24 w-full" />
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface shadow-sm p-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="mt-4 h-16 w-full" />
      </div>
    </div>
  );
}
