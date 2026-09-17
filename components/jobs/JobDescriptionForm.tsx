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

const SUCCESS_MESSAGE_DURATION_MS = 4000;

/**
 * `x / max` counter for a length-capped field, colored via the shared
 * success/warning/danger tokens as the value nears/hits the cap — added per
 * the 2026-09-10 UX pass since `title`/`description` were previously capped
 * with a silent `maxLength` and no on-screen indication, so a pasted value
 * over the limit was truncated with zero feedback.
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

/**
 * Submits a job description to `POST /api/job-descriptions` (see
 * docs/ARCHITECTURE.md §2). `title` and `description` are required;
 * `company`/`source_url`/`location`/`level` are optional. Server-side `zod`
 * validation in `lib/validation/schemas.ts` is the source of truth for
 * length caps and URL scheme — this form relies on the API's `error`
 * message rather than re-implementing those rules client-side, so
 * validation stays in one place.
 *
 * `location`/`level` were added per docs/ARCHITECTURE.md §7 so a
 * user-submitted listing can carry the same fields externally-ingested ones
 * do, and so the `/jobs` level filter works uniformly across both. `level`
 * is a fixed dropdown (`JOB_DESCRIPTION_LEVELS`) rather than free text —
 * unlike an external source, a manual submission has no existing vocabulary
 * to inherit, so offering an open text field here would just fragment the
 * filter with near-duplicate values ("Intern" vs "Internship", etc.).
 */
export function JobDescriptionForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [description, setDescription] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [location, setLocation] = useState("");
  const [level, setLevel] = useState("");
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
      const response = await fetch("/api/job-descriptions", {
        method: "POST",
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
          body?.error ?? "Couldn't submit this job description. Please try again.",
        );
        return;
      }

      setTitle("");
      setCompany("");
      setDescription("");
      setSourceUrl("");
      setLocation("");
      setLevel("");
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
        "Something went wrong submitting this job description. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface shadow-sm p-6"
    >
      <div>
        <h2 className="text-base font-semibold text-fg">
          Submit a job description
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          Job descriptions are shared data — visible to every signed-in user
          and usable for matching across the app, unlike your private
          resumes.
        </p>
      </div>

      <div>
        <Input
          id="job-title"
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
        id="job-company"
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
            htmlFor="job-level"
            className="text-sm font-medium text-fg-muted"
          >
            Level (optional)
          </label>
          <select
            id="job-level"
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
            id="job-location"
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
          htmlFor="job-description"
          className="text-sm font-medium text-fg-muted"
        >
          Description
        </label>
        <textarea
          id="job-description"
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
        id="job-source-url"
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
          Job description submitted.
        </p>
      )}

      <Button type="submit" loading={submitting} className="self-start">
        Submit job description
      </Button>
    </form>
  );
}
