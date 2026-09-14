"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface DeleteJobDescriptionButtonProps {
  jobDescriptionId: string;
  title: string;
  className?: string;
}

/**
 * Calls `DELETE /api/job-descriptions/:id` (see docs/ARCHITECTURE.md §10) —
 * same confirm-then-delete interaction pattern as `DeleteResumeButton`.
 * Unlike a resume delete, this is a **soft** delete (hides the posting; sets
 * `deleted_at`, never removes the row) — existing matches against it,
 * belonging to the submitter or to any other user, keep resolving exactly as
 * before (§10.1). The confirm copy below reflects that ("hide", not
 * "delete... can't be undone") since it's materially less destructive than
 * `DeleteResumeButton`'s resume delete.
 *
 * No `redirectTo` prop (unlike `DeleteResumeButton`) — this is only ever
 * rendered on `/jobs/:id` itself, and after a successful soft-delete that
 * same page still resolves fine (per §10.2, `getJobDescriptionById` doesn't
 * filter out soft-deleted rows), so `router.refresh()` alone re-renders the
 * page in its "removed" state (§10.5's banner) rather than navigating away.
 */
export function DeleteJobDescriptionButton({
  jobDescriptionId,
  title,
  className = "",
}: DeleteJobDescriptionButtonProps) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Hide "${title}"? It will disappear from browsing and search, but your existing matches against it are unaffected.`,
      )
    ) {
      return;
    }

    setError(null);
    setDeleting(true);
    try {
      const response = await fetch(`/api/job-descriptions/${jobDescriptionId}`, {
        method: "DELETE",
      });

      if (!response.ok && response.status !== 204) {
        const body = await response.json().catch(() => null);
        setError(
          body?.error ?? "Couldn't remove this job description. Please try again.",
        );
        return;
      }

      router.refresh();
    } catch {
      setError("Couldn't remove this job description. Please try again.");
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
        className="shrink-0 rounded-md border border-danger-border px-3 py-1.5 text-sm font-medium text-danger-fg transition-colors hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-60"
      >
        {deleting ? "Removing…" : "Remove posting"}
      </button>
      {error && <p className="max-w-[16rem] text-right text-xs text-danger-fg">{error}</p>}
    </div>
  );
}
