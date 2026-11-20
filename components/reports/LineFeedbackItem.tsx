"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { CRITIQUE_COPY, issueTypeLabel, splitPlaceholders } from "@/lib/client/critique";
import type { LineFeedback } from "@/types/domain";

interface LineFeedbackItemProps {
  item: LineFeedback;
}

type CopyState = "idle" | "copied" | "failed";

/** How long the "Copied" confirmation stays before the button resets. */
const COPY_RESET_MS = 2000;

/**
 * One line-feedback item (§13.20.6 content item 4): the user's original
 * line in a quote block, issue chips, the feedback, and the suggested
 * rewrite with `[placeholders]` marked plus a "Needs your numbers" tag when
 * `needs_user_input`.
 *
 * `original_text` is the user's exact stored characters (§13.13.2) and is
 * rendered as received: never normalized, never used for searching. All
 * text renders as React text, never HTML. Client component only for the
 * copy button; reused unchanged by M3.6.
 */
export function LineFeedbackItem({ item }: LineFeedbackItemProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(item.suggested_rewrite);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), COPY_RESET_MS);
  }

  const rewriteId = `${item.id}-rewrite`;

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Your line</p>
        <blockquote className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-border-strong pl-3 text-sm leading-relaxed text-fg-muted">
          {item.original_text}
        </blockquote>
      </div>

      {item.issue_types.length > 0 && (
        <ul aria-label="Issues" className="flex flex-wrap gap-1.5">
          {item.issue_types.map((issue) => (
            <li key={issue}>
              <Badge>{issueTypeLabel(issue)}</Badge>
            </li>
          ))}
        </ul>
      )}

      <p className="text-sm leading-relaxed text-fg">{item.feedback}</p>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <p id={`${rewriteId}-label`} className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
              Suggested rewrite
            </p>
            {item.needs_user_input && (
              <span className="inline-flex items-center rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning-fg">
                {CRITIQUE_COPY.needsInputTag}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            aria-describedby={`${rewriteId}-label`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
            </svg>
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
          </button>
        </div>
        <p
          id={rewriteId}
          className="mt-1.5 whitespace-pre-wrap break-words rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm leading-relaxed text-fg"
        >
          {splitPlaceholders(item.suggested_rewrite).map((segment, index) =>
            segment.placeholder ? (
              <mark
                key={index}
                className="rounded border border-warning-border bg-warning-bg px-1 font-medium text-warning-fg"
              >
                {segment.text}
              </mark>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
        </p>
        {item.needs_user_input && (
          <p className="mt-1.5 text-xs text-fg-subtle">{CRITIQUE_COPY.needsInputHint}</p>
        )}
        <span role="status" aria-live="polite" className="sr-only">
          {copyState === "copied"
            ? "Rewrite copied to clipboard."
            : copyState === "failed"
              ? "Couldn't copy the rewrite."
              : ""}
        </span>
      </div>
    </li>
  );
}
