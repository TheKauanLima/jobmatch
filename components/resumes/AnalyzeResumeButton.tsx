"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

interface AnalyzeResumeButtonProps {
  resumeId: string;
  /** Whether an analysis already exists, to tweak the button label. */
  hasAnalysis: boolean;
}

const RATE_LIMIT_MESSAGE =
  "You've hit today's analysis limit. Please try again tomorrow.";
const EXTRACTION_ERROR_MESSAGE =
  "We couldn't read text from this file. Try re-uploading it as a PDF, DOCX, or TXT file.";
const CLAUDE_ERROR_MESSAGE =
  "The AI analysis service is temporarily unavailable. Please try again in a few minutes.";
const GENERIC_ERROR_MESSAGE =
  "Something went wrong running the analysis. Please try again.";
const NETWORK_ERROR_MESSAGE =
  "Couldn't reach the server. Check your connection and try again.";

/**
 * Triggers `POST /api/resumes/:id/analyze` (see docs/ARCHITECTURE.md §2).
 * This call is synchronous server-side and can take several seconds, so the
 * button shows an explicit "still working" message rather than just a
 * disabled/frozen state. On success, refreshes the route so the server
 * component page re-fetches `GET /api/resumes/:id/analysis` and
 * `AnalysisPanel` picks up the new result.
 */
export function AnalyzeResumeButton({
  resumeId,
  hasAnalysis,
}: AnalyzeResumeButtonProps) {
  const router = useRouter();
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAnalyze() {
    setError(null);
    setAnalyzing(true);
    try {
      const response = await fetch(`/api/resumes/${resumeId}/analyze`, {
        method: "POST",
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (response.status === 429) {
          setError(body?.error ?? RATE_LIMIT_MESSAGE);
        } else if (response.status === 422) {
          setError(body?.error ?? EXTRACTION_ERROR_MESSAGE);
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
      setAnalyzing(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        type="button"
        variant="secondary"
        onClick={handleAnalyze}
        disabled={analyzing}
        className="shrink-0"
      >
        {analyzing
          ? "Analyzing…"
          : hasAnalysis
            ? "Re-analyze resume"
            : "Analyze resume"}
      </Button>
      {analyzing && (
        <p className="max-w-[16rem] text-right text-xs text-fg-subtle">
          This can take up to a minute — the AI is reading your resume.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="max-w-[16rem] text-right text-xs text-danger-fg"
        >
          {error}
        </p>
      )}
    </div>
  );
}
