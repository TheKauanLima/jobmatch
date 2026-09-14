import { Skeleton } from "@/components/ui/Skeleton";

/** Route-level loading UI for `/resumes` — see `components/ui/Skeleton.tsx`. */
export default function ResumesLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-3 h-4 w-80 max-w-full" />

      <Skeleton className="mt-8 h-40 w-full rounded-lg" />

      <div className="mt-8 flex flex-col gap-3">
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    </div>
  );
}
