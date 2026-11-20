import Link from "next/link";
import { BackToJobsLink } from "@/components/jobs/JobDetail";

/** Shown when `/jobs/[id]` doesn't match any listing (the API returned 404). */
export default function JobNotFound() {
  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
      <BackToJobsLink />
      <div className="mt-6 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-fg">
          This job isn&apos;t available
        </h1>
        <p className="mx-auto mt-1 max-w-sm text-sm text-fg-muted">
          The link may be mistyped, or the listing may no longer exist.
        </p>
        <Link
          href="/jobs"
          className="mt-5 inline-flex items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg shadow-sm transition-colors hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Browse jobs
        </Link>
      </div>
    </div>
  );
}
