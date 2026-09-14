import { Skeleton } from "@/components/ui/Skeleton";

/** Route-level loading UI for `/dashboard` — see `components/ui/Skeleton.tsx`. */
export default function DashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">
      <Skeleton className="h-8 w-72" />
      <Skeleton className="mt-3 h-4 w-96 max-w-full" />

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-lg border border-border bg-surface p-6">
            <Skeleton className="h-5 w-32" />
            <div className="mt-4 flex flex-col gap-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface p-6">
        <Skeleton className="h-5 w-40" />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}
