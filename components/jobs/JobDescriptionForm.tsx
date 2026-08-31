"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

/**
 * Submits a job description to `POST /api/job-descriptions` (see
 * docs/ARCHITECTURE.md §2). `title` and `description` are required;
 * `company`/`source_url` are optional. Server-side `zod` validation in
 * `lib/validation/schemas.ts` is the source of truth for length caps and URL
 * scheme — this form relies on the API's `error` message rather than
 * re-implementing those rules client-side, so validation stays in one place.
 */
export function JobDescriptionForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [description, setDescription] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

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
      router.refresh();
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
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-6"
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

      <Input
        id="job-title"
        label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Senior Backend Engineer"
        maxLength={200}
        required
        disabled={submitting}
      />

      <Input
        id="job-company"
        label="Company (optional)"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        placeholder="e.g. Acme Corp"
        maxLength={200}
        disabled={submitting}
      />

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
          maxLength={20000}
          required
          disabled={submitting}
          className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-disabled focus:border-fg-subtle focus:outline-none focus:ring-1 focus:ring-fg-subtle disabled:bg-surface-hover disabled:text-fg-subtle"
        />
      </div>

      <Input
        id="job-source-url"
        label="Source URL (optional)"
        type="url"
        value={sourceUrl}
        onChange={(e) => setSourceUrl(e.target.value)}
        placeholder="https://example.com/careers/123"
        maxLength={2048}
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

      <Button type="submit" loading={submitting} className="self-start">
        Submit job description
      </Button>
    </form>
  );
}
