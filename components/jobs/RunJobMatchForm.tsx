"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { MatchScoreBadge } from "@/components/matches/MatchScoreBadge";
import { MatchRationale } from "@/components/matches/MatchRationale";
import type { Match, ResumeListItem } from "@/types/domain";

interface RunJobMatchFormProps {
  jobDescriptionId: string;
  resumes: ResumeListItem[];
}

const NOT_ANALYZED_MESSAGE =
  "That resume hasn't finished analysis yet. Analyze it from its resume page, then try again.";
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
 * Mirror image of `components/matches/RunMatchForm.tsx`: fixed
 * `job_description_id` (this page), picks one of the caller's own analyzed
 * resumes, and posts to `POST /api/matches` (see docs/ARCHITECTURE.md §2).
 *
 * `resumes` is the caller's full resume list, fetched server-side via
 * `GET /api/resumes` and passed as props. Filtered down to `status ===
 * "analyzed"` here rather than shown with a disabled/hint state for
 * non-analyzed resumes — the API 400s on an unanalyzed resume, so filtering
 * avoids a dead-end click entirely (see this component's caller for the
 * corresponding empty-state copy when there are zero analyzed resumes).
 *
 * Unlike `RunMatchForm` (which calls `router.refresh()` and relies on
 * `MatchList` re-fetching from the server), this form has no "match history
 * for this job" list to refresh — the result is shown inline from the POST
 * response directly, kept in local state.
 */
export function RunJobMatchForm({
  jobDescriptionId,
  resumes,
}: RunJobMatchFormProps) {
  const analyzedResumes = resumes.filter((r) => r.status === "analyzed");
  const [resumeId, setResumeId] = useState(analyzedResumes[0]?.id ?? "");
  const [matching, setMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [match, setMatch] = useState<Match | null>(null);

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

      const body = await response.json().catch(() => null);
      if (body?.match) {
        setMatch(body.match);
      }
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setMatching(false);
    }
  }

  if (analyzedResumes.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        Upload and analyze a resume first to match it against this job.{" "}
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
            Resume
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

      {match && (
        <div className="mt-2 rounded-lg border border-border bg-bg p-4">
          <div className="flex items-center gap-3">
            <MatchScoreBadge score={match.score} />
            <span className="text-sm font-medium text-fg">Match result</span>
          </div>
          <div className="mt-4">
            <MatchRationale match={match} />
          </div>
        </div>
      )}
    </div>
  );
}
