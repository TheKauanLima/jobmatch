import { Skeleton } from "@/components/ui/Skeleton";

/** Route-level loading UI for `/resumes/[id]` — see `components/ui/Skeleton.tsx`. */
export default function ResumeDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-3 h-8 w-64 max-w-full" />

      <div className="mt-8 rounded-lg border border-border bg-surface shadow-sm p-6">
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
