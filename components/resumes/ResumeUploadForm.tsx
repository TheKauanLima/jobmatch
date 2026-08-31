"use client";

import { ChangeEvent, FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

const ACCEPT_ATTR =
  ".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";
const MAX_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_SIZE_LABEL = "5MB";

interface ResumeUploadFormProps {
  /** Called after a successful upload, in addition to refreshing the route. */
  onUploaded?: () => void;
}

/**
 * Uploads a single resume file to `POST /api/resumes` (multipart/form-data,
 * field name `file` — see docs/ARCHITECTURE.md §2). Client-side type/size
 * checks are a UX nicety only; the API route is the source of truth and
 * re-validates (per ARCHITECTURE.md's resolved decision: PDF/DOCX/TXT,
 * 5MB cap).
 */
export function ResumeUploadForm({ onUploaded }: ResumeUploadFormProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = event.target.files?.[0] ?? null;
    setFileName(file?.name ?? null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file to upload.");
      return;
    }

    if (file.size > MAX_SIZE_BYTES) {
      setError(`That file is too large. Max size is ${MAX_SIZE_LABEL}.`);
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/resumes", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(
          body?.error ?? "Upload failed. Please check the file and try again.",
        );
        return;
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setFileName(null);
      onUploaded?.();
      router.refresh();
    } catch {
      setError("Something went wrong uploading your resume. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-6"
    >
      <div>
        <h2 className="text-base font-semibold text-fg">
          Upload a resume
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          PDF, DOCX, or TXT. Max {MAX_SIZE_LABEL}. Your resume is private —
          only you can see it.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="resume-file"
          className="text-sm font-medium text-fg-muted"
        >
          Resume file
        </label>
        <input
          ref={fileInputRef}
          id="resume-file"
          name="file"
          type="file"
          accept={ACCEPT_ATTR}
          onChange={handleFileChange}
          disabled={uploading}
          className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg file:mr-3 file:rounded-md file:border-0 file:bg-neutral-bg file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-neutral-fg hover:file:bg-border-strong disabled:cursor-not-allowed disabled:opacity-60"
        />
        {fileName && (
          <p className="text-xs text-fg-subtle">Selected: {fileName}</p>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </p>
      )}

      <Button type="submit" loading={uploading} className="self-start">
        Upload resume
      </Button>
    </form>
  );
}
