"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import type { ResumeListItem } from "@/types/domain";

interface MatchFromJobFormProps {
  jobDescriptionId: string;
  /** Only the caller's *analyzed* resumes — see `app/jobs/[id]/page.tsx`'s filter. */
  analyzedResumes: ResumeListItem[];
}

const NOT_ANALYZED_MESSAGE =
  "That resume needs to be analyzed before it can be matched. Try again after analyzing it.";
const NOT_FOUND_MESSAGE =
  "That resume is no longer available. Please pick another.";
const RATE_LIMIT_MESSAGE =
  "You've hit today's matching limit. Please try again tomorrow.";
const CLAUDE_ERROR_MESSAGE =
  "The AI matching service is temporarily unavailable. Please try again in a few minutes.";
const GENERIC_ERROR_MESSAGE =
  "Something went wrong running the match. Please try again.";
const NETWORK_ERROR_MESSAGE =
  "Couldn't reach the server. Check your connection and try again.";

/**
 * The mirror image of `RunMatchForm`: picks one of the caller's own
 * *analyzed* resumes and matches it against this already-known job
 * description, from the job detail page (`app/jobs/[id]/page.tsx`) rather
 * than the resume detail page. Added per the 2026-09-10 UX pass — previously
 * the only way to start a match was from `/resumes/[id]`'s job picker, which
 * has no search over what's now a much larger, continually-growing board
 * (docs/ARCHITECTURE.md §7); a student browsing `/jobs` and finding a
 * specific posting had no way to act on it without first navigating away and
 * re-finding it by title.
 *
 * On success, navigates to `/resumes/[id]` for the resume just matched —
 * there's no standalone match page (docs/ARCHITECTURE.md §3) and that's
 * where `MatchList` renders the new result (score, rationale, gaps).
 */
export function MatchFromJobForm({
  jobDescriptionId,
  analyzedResumes,
}: MatchFromJobFormProps) {
  const router = useRouter();
  const [resumeId, setResumeId] = useState(analyzedResumes[0]?.id ?? "");
  const [matching, setMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleMatch() {
    if (!resumeId) return;

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

      router.push(`/resumes/${resumeId}`);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setMatching(false);
    }
  }

  if (analyzedResumes.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        Upload and analyze a resume first to match it against this listing.{" "}
        <Link href="/resumes" className="underline hover:text-fg">
          Go to your resumes
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <label
            htmlFor="match-resume"
            className="text-sm font-medium text-fg-muted"
          >
            Your resume
          </label>
          <select
            id="match-resume"
            value={resumeId}
            onChange={(event) => setResumeId(event.target.value)}
            disabled={matching}
            className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg focus:border-fg-subtle focus:outline-none focus:ring-1 focus:ring-fg-subtle disabled:bg-surface-hover disabled:text-fg-subtle"
          >
            {analyzedResumes.map((resume) => (
              <option key={resume.id} value={resume.id}>
                {resume.file_name}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          onClick={handleMatch}
          disabled={matching || !resumeId}
          className="shrink-0"
        >
          {matching ? "Matching…" : "Match against this job"}
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
