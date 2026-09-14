import { Skeleton } from "@/components/ui/Skeleton";

/** Route-level loading UI for `/jobs` — see `components/ui/Skeleton.tsx`. */
export default function JobsLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="mt-3 h-4 w-full max-w-lg" />

      <Skeleton className="mt-8 h-56 w-full rounded-lg" />

      <div className="mt-8 flex gap-2">
        <Skeleton className="h-6 w-14 rounded-full" />
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-6 w-24 rounded-full" />
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    </div>
  );
}
