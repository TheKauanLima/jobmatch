"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface DeleteResumeButtonProps {
  resumeId: string;
  fileName: string;
  /** If set, navigate here after a successful delete (used on the detail page). */
  redirectTo?: string;
  className?: string;
}

/**
 * Calls `DELETE /api/resumes/:id` (see docs/ARCHITECTURE.md §2). On success,
 * either navigates to `redirectTo` (detail page, since the resume no longer
 * exists there) or just refreshes the current route (list page, so the
 * server-rendered list drops the deleted row).
 */
export function DeleteResumeButton({
  resumeId,
  fileName,
  redirectTo,
  className = "",
}: DeleteResumeButtonProps) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Delete "${fileName}"? This can't be undone.`)
    ) {
      return;
    }

    setError(null);
    setDeleting(true);
    try {
      const response = await fetch(`/api/resumes/${resumeId}`, {
        method: "DELETE",
      });

      if (!response.ok && response.status !== 204) {
        const body = await response.json().catch(() => null);
        setError(
          body?.error ?? "Couldn't delete this resume. Please try again.",
        );
        return;
      }

      if (redirectTo) {
        router.push(redirectTo);
      }
      router.refresh();
    } catch {
      setError("Couldn't delete this resume. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={`flex flex-col items-end gap-1 ${className}`}>
      <button
        type="button"
        onClick={handleDelete}
        disabled={deleting}
        className="shrink-0 rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {deleting ? "Deleting…" : "Delete"}
      </button>
      {error && <p className="max-w-[16rem] text-right text-xs text-red-700">{error}</p>}
    </div>
  );
}
