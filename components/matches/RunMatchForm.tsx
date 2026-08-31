"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import type { JobDescription } from "@/types/domain";

interface RunMatchFormProps {
  resumeId: string;
  jobDescriptions: JobDescription[];
}

const NOT_ANALYZED_MESSAGE =
  "This resume needs to be analyzed before it can be matched. Run an analysis above, then try again.";
const NOT_FOUND_MESSAGE =
  "That job description is no longer available. Please pick another.";
const RATE_LIMIT_MESSAGE =
  "You've hit today's matching limit. Please try again tomorrow.";
const CLAUDE_ERROR_MESSAGE =
  "The AI matching service is temporarily unavailable. Please try again in a few minutes.";
const GENERIC_ERROR_MESSAGE =
  "Something went wrong running the match. Please try again.";
const NETWORK_ERROR_MESSAGE =
  "Couldn't reach the server. Check your connection and try again.";

/**
 * Picks a job description and triggers `POST /api/matches` (see
 * docs/ARCHITECTURE.md §2) for the given resume. Only rendered by
 * `app/resumes/[id]/page.tsx` once the resume has an analysis — the API
 * itself would 400 otherwise, but the page gates the picker away entirely so
 * that error path shouldn't normally be reachable; still handled below
 * defensively.
 *
 * `jobDescriptions` is a first-page snapshot (see `RunMatchForm`'s caller —
 * `GET /api/job-descriptions?limit=50`, no search UI for v1) fetched
 * server-side and passed as props; read directly, no local copy, since this
 * list is never mutated from within the form itself.
 *
 * This call is synchronous server-side and can take several seconds (same
 * pattern as `AnalyzeResumeButton`), so the button shows an explicit
 * "still working" message. On success, refreshes the route so the server
 * component page re-fetches `GET /api/matches` and `MatchList` picks up the
 * new result.
 */
export function RunMatchForm({ resumeId, jobDescriptions }: RunMatchFormProps) {
  const router = useRouter();
  const [jobDescriptionId, setJobDescriptionId] = useState(
    jobDescriptions[0]?.id ?? "",
  );
  const [matching, setMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleMatch() {
    if (!jobDescriptionId) return;

    setError(null);
    setMatching(true);
    try {
      const response = await fetch("/api/matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resume_id: resumeId,
          job_description_id: jobDescriptionId,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (response.status === 400) {
          setError(body?.error ?? NOT_ANALYZED_MESSAGE);
        } else if (response.status === 404) {
          setError(body?.error ?? NOT_FOUND_MESSAGE);
        } else if (response.status === 429) {
          setError(body?.error ?? RATE_LIMIT_MESSAGE);
        } else if (response.status === 502) {
          setError(body?.error ?? CLAUDE_ERROR_MESSAGE);
        } else {
          setError(body?.error ?? GENERIC_ERROR_MESSAGE);
        }
        return;
      }

      router.refresh();
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setMatching(false);
    }
  }

  if (jobDescriptions.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No job descriptions are available to match against yet.{" "}
        <Link href="/jobs" className="underline hover:text-fg">
          Submit one
        </Link>{" "}
        to get started.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <label
            htmlFor="match-job-description"
            className="text-sm font-medium text-fg-muted"
          >
            Job description
          </label>
          <select
            id="match-job-description"
            value={jobDescriptionId}
            onChange={(event) => setJobDescriptionId(event.target.value)}
            disabled={matching}
            className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg focus:border-fg-subtle focus:outline-none focus:ring-1 focus:ring-fg-subtle disabled:bg-surface-hover disabled:text-fg-subtle"
          >
            {jobDescriptions.map((jobDescription) => (
              <option key={jobDescription.id} value={jobDescription.id}>
                {jobDescription.title}
                {jobDescription.company ? ` — ${jobDescription.company}` : ""}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          onClick={handleMatch}
          disabled={matching || !jobDescriptionId}
          className="shrink-0"
        >
          {matching ? "Matching…" : "Match"}
        </Button>
      </div>
      {matching && (
        <p className="text-xs text-fg-subtle">
          This can take up to a minute — the AI is comparing your resume to
          the job description.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}
