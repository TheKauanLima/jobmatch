"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type Ref } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import {
  CRITIQUE_COPY,
  formatElapsed,
  outcomeToRunResult,
  requestCritiqueRun,
} from "@/lib/client/critique";

interface RunCritiqueButtonProps {
  resumeId: string;
  /** Button label; defaults to "Run critique". */
  label?: string;
  variant?: "primary" | "secondary";
}

interface RunError {
  message: string;
  showLogin: boolean;
  showRefresh: boolean;
}

/**
 * Triggers `POST /api/resumes/:id/critique` (docs/ARCHITECTURE.md §13.20.4)
 * and, on success, `router.refresh()`es so the page's GET shows the result
 * (§13.20.6). V1-only; removed in M3.7.
 *
 * The run is synchronous and takes about 40 s (measured; up to a few minutes worst case), so while it's pending the
 * button is disabled (plus a ref guard against a fast double click), a
 * polite live region explains the wait, and leaving the page asks for
 * confirmation: a reload mid-run followed by a second POST can be charged
 * twice (§13.20.8). Errors are mapped by `lib/client/critique.ts` and shown
 * inline with `role="alert"`, which receives focus.
 */
export function RunCritiqueButton({ resumeId, label, variant }: RunCritiqueButtonProps) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<RunError | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const inFlight = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);

  const pending = running || refreshing;

  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 1000);
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers need returnValue set to show the prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", warnBeforeLeaving);
    };
  }, [running]);

  async function handleRun() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setElapsed(0);
    setRunning(true);

    const result = outcomeToRunResult(await requestCritiqueRun(resumeId));

    setRunning(false);
    if (result.type === "refresh") {
      // Stays disabled until the refreshed page replaces this button.
      startRefresh(() => router.refresh());
      inFlight.current = false;
      return;
    }

    inFlight.current = false;
    setError({ message: result.message, showLogin: result.showLogin, showRefresh: result.showRefresh });
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  return (
    <RunCritiqueButtonView
      label={label ?? CRITIQUE_COPY.runLabel}
      variant={variant}
      pending={pending}
      elapsedSeconds={running ? elapsed : null}
      error={error}
      errorRef={errorRef}
      onRun={handleRun}
      onRefresh={() => window.location.reload()}
    />
  );
}

interface RunCritiqueButtonViewProps {
  label: string;
  variant?: "primary" | "secondary";
  pending: boolean;
  /** Seconds since the run started, or null when not running. */
  elapsedSeconds: number | null;
  error: RunError | null;
  errorRef?: Ref<HTMLDivElement>;
  onRun: () => void;
  onRefresh: () => void;
}

/** Pure renderer for the button's states; exported for tests. */
export function RunCritiqueButtonView({
  label,
  variant = "primary",
  pending,
  elapsedSeconds,
  error,
  errorRef,
  onRun,
  onRefresh,
}: RunCritiqueButtonViewProps) {
  return (
    <div className="flex w-full flex-col gap-3 sm:w-auto">
      <Button
        type="button"
        variant={variant}
        onClick={onRun}
        disabled={pending}
        className="w-full gap-2 sm:w-auto sm:self-start"
      >
        {pending && (
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        )}
        {pending ? CRITIQUE_COPY.runningLabel : label}
      </Button>

      {/* Always mounted so screen readers pick up the message when it appears.
          Out of flow (sr-only) while empty, so it adds no gap. */}
      <div aria-live="polite" className={pending ? "text-sm text-fg-muted" : "sr-only"}>
        {pending ? <p>{CRITIQUE_COPY.running}</p> : null}
      </div>
      {elapsedSeconds !== null && (
        <p className="text-xs tabular-nums text-fg-subtle">
          Elapsed {formatElapsed(elapsedSeconds)}
        </p>
      )}

      {error && (
        <div
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <p>{error.message}</p>
          {(error.showLogin || error.showRefresh) && (
            <p className="mt-2">
              {error.showLogin && (
                <Link href="/login" className="font-medium underline underline-offset-2">
                  Log in again
                </Link>
              )}
              {error.showRefresh && (
                <button
                  type="button"
                  onClick={onRefresh}
                  className="font-medium underline underline-offset-2"
                >
                  Refresh page
                </button>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
