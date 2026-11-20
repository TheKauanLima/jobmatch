import type { RateLimitKind } from "@/types/database";

/**
 * Client-side loading + display helpers for `GET /api/account/limits`
 * (docs/ARCHITECTURE.md §13.13.7). React-free so `UsageLimits` stays a thin
 * renderer and the states are unit-testable.
 */

export interface UsageLimit {
  kind: string;
  daily_limit: number;
  used_today: number;
  /** ISO timestamp of the next UTC midnight. */
  resets_at: string;
}

export type UsageLimitsState =
  | { status: "loading" }
  | { status: "loaded"; limits: UsageLimit[] }
  | { status: "unauthorized" }
  | { status: "error" };

/**
 * Human-readable labels for every `rate_limit_events.kind` (§13.3.1), with
 * what each one counts (§13.9.3, §13.13). Ordered as shown in the panel.
 */
export const RATE_LIMIT_KIND_LABELS: Record<
  RateLimitKind,
  { label: string; description: string }
> = {
  resume_report: {
    label: "Resume reports",
    description: "Full resume analyses you start, including the critique and job matches.",
  },
  refresh_matches: {
    label: "Match refreshes",
    description: "Re-running job matching for a resume that already has a report.",
  },
  fit_check: {
    label: "Fit checks",
    description: "Checking how well a resume fits a specific job listing.",
  },
  url_import: {
    label: "Listing imports from a link",
    description: "Importing a job listing by pasting its web address.",
  },
  job_listing_create: {
    label: "Job listings added",
    description: "Job listings you submit, shared or private.",
  },
  job_listing_update: {
    label: "Job listing edits",
    description: "Changes to the content of job listings you submitted.",
  },
  account_reauth: {
    label: "Password confirmations",
    description:
      "Times you confirm your password for a sensitive action, such as deleting your account.",
  },
};

const KIND_ORDER = Object.keys(RATE_LIMIT_KIND_LABELS);

/** Label for a kind, with a readable fallback for a kind added later. */
export function labelForKind(kind: string): { label: string; description: string | null } {
  if (Object.hasOwn(RATE_LIMIT_KIND_LABELS, kind)) {
    return RATE_LIMIT_KIND_LABELS[kind as RateLimitKind];
  }
  const words = kind.replace(/_/g, " ").trim();
  return {
    label: words.charAt(0).toUpperCase() + words.slice(1),
    description: null,
  };
}

/** Known kinds in their documented order, then any unknown kinds by name. */
export function sortLimits(limits: UsageLimit[]): UsageLimit[] {
  const rank = (kind: string) => {
    const index = KIND_ORDER.indexOf(kind);
    return index === -1 ? KIND_ORDER.length : index;
  };
  return [...limits].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind),
  );
}

function isUsageLimit(value: unknown): value is UsageLimit {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.kind === "string" &&
    typeof row.daily_limit === "number" &&
    typeof row.used_today === "number" &&
    typeof row.resets_at === "string"
  );
}

/**
 * Fetches the caller's limits and maps the response to a panel state.
 * Never throws. Malformed rows are dropped rather than rendered as NaN; a
 * body without a `limits` array is treated as an error.
 */
export async function loadUsageLimits(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Exclude<UsageLimitsState, { status: "loading" }>> {
  try {
    const response = await fetchImpl("/api/account/limits", {
      cache: "no-store",
      signal,
    });
    if (response.status === 401) return { status: "unauthorized" };
    if (!response.ok) return { status: "error" };

    const body: unknown = await response.json();
    const rows =
      body !== null && typeof body === "object" && "limits" in body
        ? body.limits
        : undefined;
    if (!Array.isArray(rows)) return { status: "error" };

    return { status: "loaded", limits: sortLimits(rows.filter(isUsageLimit)) };
  } catch {
    return { status: "error" };
  }
}

/** Every row's `resets_at`, if they are all the same (the normal case). */
export function sharedResetTime(limits: UsageLimit[]): string | null {
  if (limits.length === 0) return null;
  const first = limits[0].resets_at;
  return limits.every((limit) => limit.resets_at === first) ? first : null;
}
