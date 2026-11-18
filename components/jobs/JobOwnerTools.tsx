import type { JobDescription } from "@/types/domain";
import { EditJobDescriptionForm } from "@/components/jobs/EditJobDescriptionForm";
import { DeleteJobDescriptionButton } from "@/components/jobs/DeleteJobDescriptionButton";

/**
 * Edit/remove controls for the caller's own posting, shown on `/jobs/[id]`
 * only when `is_own` (the API re-checks ownership on every PATCH/DELETE, so
 * this is a UI convenience, not access control). The edit form is collapsed
 * by default so it doesn't dominate the page for the owner.
 */
export function JobOwnerTools({ job }: { job: JobDescription }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-muted">
        You shared this posting, so you can edit or remove it. Changes are
        visible to every signed-in user.
      </p>

      <details className="group rounded-md border border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-4 py-2.5 text-sm font-medium text-fg hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          Edit posting details
          <span aria-hidden="true" className="text-fg-subtle transition-transform group-open:rotate-180">
            &#9662;
          </span>
        </summary>
        <div className="border-t border-border px-4 py-4">
          <EditJobDescriptionForm jobDescription={job} embedded />
        </div>
      </details>

      {!job.deleted_at && (
        <DeleteJobDescriptionButton
          jobDescriptionId={job.id}
          title={job.title}
          align="start"
        />
      )}
    </div>
  );
}
