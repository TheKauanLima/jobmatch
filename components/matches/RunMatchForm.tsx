"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
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
const SEARCH_ERROR_MESSAGE =
  "Couldn't search job descriptions. Please try again.";

// Debounce delay for the live search fetch, per docs/ARCHITECTURE.md §9.4.
const SEARCH_DEBOUNCE_MS = 300;
// No `?level=` and no pagination for this picker — see §9.4: it's a "find
// the one job I mean" tool, not a browsing surface.
const SEARCH_RESULT_LIMIT = 20;

/**
 * Picks a job description and triggers `POST /api/matches` (see
 * docs/ARCHITECTURE.md §2) for the given resume. Only rendered by
 * `app/resumes/[id]/page.tsx` once the resume has an analysis — the API
 * itself would 400 otherwise, but the page gates the picker away entirely so
 * that error path shouldn't normally be reachable; still handled below
 * defensively.
 *
 * `jobDescriptions` is a first-page snapshot (see `RunMatchForm`'s caller —
 * `GET /api/job-descriptions?limit=50`) fetched server-side and passed as
 * props; read directly, no local copy, since this list is never mutated from
 * within the form itself. It's shown as-is whenever the filter input is
 * empty, preserving the original "browse the 50 most recent" default with no
 * extra requests on mount.
 *
 * Once the filter input is non-empty, per the 2026-09-11 server-side search
 * pass (docs/ARCHITECTURE.md §9.4), this switches from the old client-side
 * array filter to a debounced (~300ms) client-side fetch of
 * `GET /api/job-descriptions?q=<filter>&limit=20` (no `?level=` — this
 * picker was never level-scoped). Deliberately a single page, no "Load
 * more"/cursor — the top 20 relevance-ranked results are it; if the job
 * isn't there, the answer is "narrow the search term."
 *
 * This call is synchronous server-side and can take several seconds (same
 * pattern as `AnalyzeResumeButton`), so the button shows an explicit
 * "still working" message. On success, refreshes the route so the server
 * component page re-fetches `GET /api/matches` and `MatchList` picks up the
 * new result.
 */
export function RunMatchForm({ resumeId, jobDescriptions }: RunMatchFormProps) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [jobDescriptionId, setJobDescriptionId] = useState(
    jobDescriptions[0]?.id ?? "",
  );
  const [matching, setMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `null` = search not active (filter is empty) — fall back to the
  // `jobDescriptions` prop snapshot. Once populated (even with an empty
  // array, meaning "zero results"), it's the source of truth while the
  // filter is non-empty.
  const [searchResults, setSearchResults] = useState<JobDescription[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const isSearchActive = filter.trim().length > 0;

  useEffect(() => {
    // Nothing to do while the filter is empty — `isSearchActive` already
    // gates the render below back to the `jobDescriptions` snapshot, so
    // stale `searchResults`/`searchError` from a prior search are simply
    // ignored rather than needing to be reset here.
    const term = filter.trim();
    if (!term) {
      return;
    }

    const controller = new AbortController();

    const timeoutId = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const params = new URLSearchParams({
          q: term,
          limit: String(SEARCH_RESULT_LIMIT),
        });
        const response = await fetch(`/api/job-descriptions?${params}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          setSearchError(SEARCH_ERROR_MESSAGE);
          setSearchResults(null);
          return;
        }

        const body = await response.json();
        setSearchResults(body.job_descriptions ?? []);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setSearchError(SEARCH_ERROR_MESSAGE);
        setSearchResults(null);
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [filter]);

  // The list currently visible in the picker: the search results once the
  // filter is non-empty (even mid-flight, so a slow first search doesn't
  // briefly flash the old 50-row snapshot), otherwise the original snapshot.
  const visibleJobDescriptions = isSearchActive
    ? (searchResults ?? [])
    : jobDescriptions;

  // Keep the selection valid as the visible list changes — falls back to the
  // first still-visible option rather than leaving a no-longer-visible id
  // selected (which would silently match against a job the dropdown no
  // longer shows).
  const selectedStillVisible = visibleJobDescriptions.some(
    (jd) => jd.id === jobDescriptionId,
  );
  const effectiveJobDescriptionId = selectedStillVisible
    ? jobDescriptionId
    : (visibleJobDescriptions[0]?.id ?? "");

  async function handleMatch() {
    if (!effectiveJobDescriptionId) return;

    setError(null);
    setMatching(true);
    try {
      const response = await fetch("/api/matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resume_id: resumeId,
          job_description_id: effectiveJobDescriptionId,
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
      <Input
        id="match-job-filter"
        label="Search by title, company, or keyword"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="e.g. intern, or a company name"
        disabled={matching}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <label
            htmlFor="match-job-description"
            className="text-sm font-medium text-fg-muted"
          >
            Job description
          </label>
          {isSearchActive && searching ? (
            <p className="text-sm text-fg-subtle">Searching…</p>
          ) : isSearchActive && searchError ? (
            <p role="alert" className="text-sm text-danger-fg">
              {searchError}
            </p>
          ) : visibleJobDescriptions.length === 0 ? (
            <p className="text-sm text-fg-subtle">
              No job descriptions match &ldquo;{filter}&rdquo;.
            </p>
          ) : (
            <select
              id="match-job-description"
              value={effectiveJobDescriptionId}
              onChange={(event) => setJobDescriptionId(event.target.value)}
              disabled={matching}
              className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg focus:border-fg-subtle focus:outline-none focus:ring-1 focus:ring-fg-subtle disabled:bg-surface-hover disabled:text-fg-subtle"
            >
              {visibleJobDescriptions.map((jobDescription) => (
                <option key={jobDescription.id} value={jobDescription.id}>
                  {jobDescription.title}
                  {jobDescription.company ? ` — ${jobDescription.company}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
        <Button
          type="button"
          onClick={handleMatch}
          disabled={matching || !effectiveJobDescriptionId}
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
