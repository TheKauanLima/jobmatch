import { Skeleton } from "@/components/ui/Skeleton";

/** Route-level loading UI for `/jobs/[id]`, mirroring `JobDetailView`. */
export default function JobDescriptionDetailLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12"
    >
      <p role="status" className="sr-only">
        Loading job&hellip;
      </p>
      <Skeleton className="h-4 w-20" />

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-8">
        <div className="lg:col-start-1 lg:row-start-1">
          <Skeleton className="h-8 w-80 max-w-full" />
          <div className="mt-3 flex gap-5">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-28" />
          </div>
          <div className="mt-3 flex gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        </div>

        <div className="rounded-lg border border-border bg-surface p-5 shadow-sm lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
          <Skeleton className="h-4 w-20" />
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="mt-4 flex justify-between">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
          <Skeleton className="mt-6 h-10 w-full" />
        </div>

        <div className="flex flex-col gap-6 lg:col-start-1 lg:row-start-2">
          <div className="rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6">
            <Skeleton className="h-6 w-36" />
            <Skeleton className="mt-4 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-11/12" />
            <Skeleton className="mt-2 h-4 w-4/5" />
            <Skeleton className="mt-6 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-3/4" />
          </div>
          <div className="rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="mt-4 h-10 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
