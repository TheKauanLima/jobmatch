import { Skeleton } from "@/components/ui/Skeleton";
import { CARD } from "@/components/dashboard/styles";

/** Route-level loading UI for `/dashboard`, shaped like `DashboardView`. */
export default function DashboardLoading() {
  return (
    <div
      className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12"
      aria-busy="true"
    >
      <p role="status" className="sr-only">
        Loading your dashboard
      </p>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="mt-3 h-4 w-72 max-w-full" />

      <div className={`mt-8 ${CARD}`}>
        <Skeleton className="h-4 w-28" />
        <Skeleton className="mt-5 h-6 w-3/4" />
        <Skeleton className="mt-3 h-4 w-1/2" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {[0, 1].map((i) => (
            <div key={i} className={CARD}>
              <Skeleton className="h-5 w-32" />
              <div className="mt-4 flex flex-col gap-3">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-6">
          <div className={CARD}>
            <Skeleton className="h-5 w-28" />
            <Skeleton className="mt-4 h-4 w-40" />
            <Skeleton className="mt-3 h-2 w-full" />
          </div>
          <div className={CARD}>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="mt-4 h-24 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
