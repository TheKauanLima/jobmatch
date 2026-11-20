"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatLocalDateTime } from "@/lib/client/formatDateTime";
import {
  labelForKind,
  loadUsageLimits,
  sharedResetTime,
  type UsageLimit,
  type UsageLimitsState,
} from "@/lib/client/usageLimits";

/**
 * Settings panel listing the caller's daily limits, today's usage and when
 * they reset (docs/ARCHITECTURE.md §13.13.7 `GET /api/account/limits`,
 * §13.14). Fetched on the client so the panel can show its own loading,
 * error and retry states without blocking the rest of the settings page.
 * The endpoint is `private, no-store`; the fetch also opts out of caching.
 */
export function UsageLimits() {
  const [state, setState] = useState<UsageLimitsState>({ status: "loading" });

  const load = useCallback((signal?: AbortSignal) => {
    loadUsageLimits(fetch, signal).then((next) => {
      if (!signal?.aborted) setState(next);
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function handleRetry() {
    setState({ status: "loading" });
    load();
  }

  return <UsageLimitsView state={state} onRetry={handleRetry} />;
}

interface UsageLimitsViewProps {
  state: UsageLimitsState;
  onRetry: () => void;
}

/** Pure renderer for each panel state; exported for tests. */
export function UsageLimitsView({ state, onRetry }: UsageLimitsViewProps) {
  if (state.status === "loading") {
    return (
      <div aria-busy="true" className="flex flex-col gap-3">
        <p role="status" className="sr-only">
          Loading your usage limits…
        </p>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (state.status === "unauthorized") {
    return (
      <p className="text-sm text-fg-muted">
        Your session has ended.{" "}
        <Link
          href="/login"
          className="font-medium text-fg underline underline-offset-2"
        >
          Log in again
        </Link>{" "}
        to see your usage.
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          We couldn&apos;t load your usage limits. Please try again.
        </p>
        <Button type="button" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (state.limits.length === 0) {
    return (
      <p className="text-sm text-fg-subtle">
        No daily limits apply to your account right now.
      </p>
    );
  }

  const sharedReset = formatLocalDateTime(sharedResetTime(state.limits));

  return (
    <div className="flex flex-col gap-4">
      {sharedReset && (
        <p className="text-sm text-fg-muted">
          All limits reset at {sharedReset}.
        </p>
      )}
      <ul className="divide-y divide-border rounded-md border border-border">
        {state.limits.map((limit) => (
          <UsageLimitRow
            key={limit.kind}
            limit={limit}
            showReset={sharedReset === null}
          />
        ))}
      </ul>
    </div>
  );
}

function UsageLimitRow({
  limit,
  showReset,
}: {
  limit: UsageLimit;
  showReset: boolean;
}) {
  const { label, description } = labelForKind(limit.kind);
  const used = Math.max(0, limit.used_today);
  const max = Math.max(0, limit.daily_limit);
  const reached = used >= max;
  const percent = max === 0 ? 100 : Math.min(100, Math.round((used / max) * 100));
  const resets = showReset ? formatLocalDateTime(limit.resets_at) : null;

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">{label}</p>
          {description && (
            <p className="mt-0.5 text-xs text-fg-subtle">{description}</p>
          )}
        </div>
        <p className="shrink-0 text-sm text-fg-muted">
          {used} of {max} used today
          {reached && (
            <span className="ml-2 inline-flex items-center rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning-fg">
              Limit reached
            </span>
          )}
        </p>
      </div>
      <div aria-hidden="true" className="h-1.5 w-full rounded-full bg-neutral-bg">
        <div
          className={`h-1.5 rounded-full ${reached ? "bg-warning-fg" : "bg-accent"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {resets && <p className="text-xs text-fg-subtle">Resets at {resets}.</p>}
    </li>
  );
}
