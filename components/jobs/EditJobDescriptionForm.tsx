"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  JOB_DESCRIPTION_COMPANY_MAX_LENGTH,
  JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_LEVELS,
  JOB_DESCRIPTION_LOCATION_MAX_LENGTH,
  JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH,
  JOB_DESCRIPTION_TITLE_MAX_LENGTH,
} from "@/lib/validation/schemas";
import type { JobDescription } from "@/types/domain";

const SUCCESS_MESSAGE_DURATION_MS = 4000;

/**
 * `x / max` counter for a length-capped field — identical to
 * `JobDescriptionForm`'s `CharCount`, duplicated here rather than shared
 * since it's a small, private presentational helper local to each form (same
 * call as `JobDescriptionForm` already made, not a new pattern).
 */
function CharCount({ value, max }: { value: string; max: number }) {
  const remaining = max - value.length;
  const atCap = remaining <= 0;
  const nearCap = !atCap && remaining <= Math.max(1, Math.floor(max * 0.05));

  return (
    <p
      className={`text-right text-xs ${
        atCap
          ? "text-danger-fg"
          : nearCap
            ? "text-warning-fg"
            : "text-fg-subtle"
      }`}
    >
      {value.length.toLocaleString()} / {max.toLocaleString()}
    </p>
  );
}

interface EditJobDescriptionFormProps {
  jobDescription: JobDescription;
}

/**
 * Pre-filled edit form for a job description the caller submitted —
 * `PATCH`s `/api/job-descriptions/:id` on submit (docs/ARCHITECTURE.md §10).
 * Same field set/validation/character-counter pattern as
 * `JobDescriptionForm` (the create form) — server-side `zod` validation in
 * `lib/validation/schemas.ts#jobDescriptionUpdateSchema` is the source of
 * truth for length caps/URL scheme here too, so this relies on the API's
 * `error` message rather than re-implementing those rules.
 *
 * Only ever rendered by `app/jobs/[id]/page.tsx` when `jobDescription.is_own`
 * is `true` — the API independently re-checks ownership
 * (`submitted_by`/`source`) on every `PATCH`, so this is a UI convenience,
 * not the actual access control.
 *
 * Known gap (flagged, not silently worked around): like
 * `JobDescriptionForm`, optional fields are omitted from the request body
 * when blank rather than sent as `null`
 * (`company.trim() || undefined`) — `jobDescriptionUpdateSchema` treats a
 * present-but-empty string as invalid (`.min(1, "... must not be empty when
 * provided.")`) and an *absent* key as "leave this column untouched" (see
 * `updateJobDescription` in `lib/supabase/queries/jobDescriptions.ts`), and
 * accepts neither `null` nor `""` for these fields. That means there is
 * currently no way, via this form or the API it calls, to clear an
 * already-set `company`/`source_url`/`location`/`level` back to empty — only
 * to change it to a different non-empty value. This wasn't called out in
 * §10.3/§10.5, so it's noted here rather than fixed by loosening
 * `lib/validation/schemas.ts` (backend-dev/architect's call, not
 * frontend's).
 */
export function EditJobDescriptionForm({
  jobDescription,
}: EditJobDescriptionFormProps) {
  const router = useRouter();
  const [title, setTitle] = useState(jobDescription.title);
  const [company, setCompany] = useState(jobDescription.company ?? "");
  const [description, setDescription] = useState(jobDescription.description);
  const [sourceUrl, setSourceUrl] = useState(jobDescription.source_url ?? "");
  const [location, setLocation] = useState(jobDescription.location ?? "");
  const [level, setLevel] = useState(jobDescription.level ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setShowSuccess(false);

    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (!description.trim()) {
      setError("Description is required.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`/api/job-descriptions/${jobDescription.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          company: company.trim() || undefined,
          description: description.trim(),
          source_url: sourceUrl.trim() || undefined,
          location: location.trim() || undefined,
          level: level || undefined,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(
          body?.error ?? "Couldn't update this job description. Please try again.",
        );
        return;
      }

      router.refresh();

      setShowSuccess(true);
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
      successTimeoutRef.current = setTimeout(
        () => setShowSuccess(false),
        SUCCESS_MESSAGE_DURATION_MS,
      );
    } catch {
      setError(
        "Something went wrong updating this job description. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-6"
    >
      <div>
        <h2 className="text-base font-semibold text-fg">
          Edit this job description
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          Changes here are visible to every signed-in user. Existing matches
          against this posting keep their original rationale — only the title
          and company shown next to them update.
        </p>
      </div>

      <div>
        <Input
          id="edit-job-title"
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Senior Backend Engineer"
          maxLength={JOB_DESCRIPTION_TITLE_MAX_LENGTH}
          required
          disabled={submitting}
        />
        <CharCount value={title} max={JOB_DESCRIPTION_TITLE_MAX_LENGTH} />
      </div>

      <Input
        id="edit-job-company"
        label="Company (optional)"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        placeholder="e.g. Acme Corp"
        maxLength={JOB_DESCRIPTION_COMPANY_MAX_LENGTH}
        disabled={submitting}
      />

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex flex-1 flex-col gap-1.5">
          <label
            htmlFor="edit-job-level"
            className="text-sm font-medium text-fg-muted"
          >
            Level (optional)
          </label>
          <select
            id="edit-job-level"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            disabled={submitting}
            className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg focus:border-fg-subtle focus:outline-none focus:ring-1 focus:ring-fg-subtle disabled:bg-surface-hover disabled:text-fg-subtle"
          >
            <option value="">Not specified</option>
            {JOB_DESCRIPTION_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1">
          <Input
            id="edit-job-location"
            label="Location (optional)"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Remote, or New York, NY"
            maxLength={JOB_DESCRIPTION_LOCATION_MAX_LENGTH}
            disabled={submitting}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="edit-job-description"
          className="text-sm font-medium text-fg-muted"
        >
          Description
        </label>
        <textarea
          id="edit-job-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Paste the full job description here."
          rows={8}
          maxLength={JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH}
          required
          disabled={submitting}
          className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-disabled focus:border-fg-subtle focus:outline-none focus:ring-1 focus:ring-fg-subtle disabled:bg-surface-hover disabled:text-fg-subtle"
        />
        <CharCount
          value={description}
          max={JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH}
        />
      </div>

      <Input
        id="edit-job-source-url"
        label="Source URL (optional)"
        type="url"
        value={sourceUrl}
        onChange={(e) => setSourceUrl(e.target.value)}
        placeholder="https://example.com/careers/123"
        maxLength={JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH}
        disabled={submitting}
      />

      {error && (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </p>
      )}

      {showSuccess && (
        <p className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success-fg">
          Job description updated.
        </p>
      )}

      <Button type="submit" loading={submitting} className="self-start">
        Save changes
      </Button>
    </form>
  );
}
