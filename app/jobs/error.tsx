"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

/**
 * Error boundary for `/jobs` and `/jobs/[id]` (uncaught render errors only;
 * expected API failures are handled inline by each page). Uses this Next.js
 * version's `retry` prop, which re-fetches and re-renders the segment.
 */
export default function JobsError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Message only: never log job/resume content.
    console.error("jobs route error:", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-12 sm:px-6">
      <div
        role="alert"
        className="rounded-lg border border-danger-border bg-danger-bg px-5 py-6"
      >
        <h1 className="text-lg font-semibold text-danger-fg">
          Something went wrong loading jobs
        </h1>
        <p className="mt-1 text-sm text-danger-fg">
          Please try again. If it keeps happening, come back in a few minutes.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button type="button" onClick={() => retry()}>
            Try again
          </Button>
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-fg shadow-sm transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
