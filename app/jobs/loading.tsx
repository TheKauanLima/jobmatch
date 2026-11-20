import { Skeleton } from "@/components/ui/Skeleton";
import { JobsResultsSkeleton } from "@/components/jobs/JobsBoardStates";

/** Route-level loading UI for `/jobs`, mirroring `JobsBoardLayout`. */
export default function JobsLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
      <Skeleton className="h-8 w-28" />
      <Skeleton className="mt-3 h-4 w-full max-w-xl" />
      <Skeleton className="mt-2 h-4 w-2/3 max-w-md" />

      <Skeleton className="mt-6 h-16 w-full rounded-lg" />

      <div className="mt-8 flex flex-col gap-2 sm:flex-row">
        <Skeleton className="h-10 flex-1" />
        <Skeleton className="h-10 w-full sm:w-24" />
      </div>
      <div className="mt-4 flex gap-2">
        <Skeleton className="h-8 w-24 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
        <Skeleton className="h-8 w-28 rounded-full" />
      </div>

      <div className="mt-6">
        <JobsResultsSkeleton />
      </div>
    </div>
  );
}
