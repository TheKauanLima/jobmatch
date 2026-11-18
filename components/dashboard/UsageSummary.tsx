import Link from "next/link";

import { ALERT, CARD, HEADER_LINK } from "@/components/dashboard/styles";
import { clampScore } from "@/lib/client/critique";
import { quotaHeadline, type CritiqueQuota, type Section } from "@/lib/client/dashboard";

interface UsageSummaryProps {
  quota: Section<CritiqueQuota | null>;
}

/**
 * "Today's usage": critiques left today (the `resume_report` limit the
 * critique is charged to, §13.20.1 decision 3), with a link to the full
 * breakdown in Settings. Display only: the server enforces the limit.
 */
export function UsageSummary({ quota }: UsageSummaryProps) {
  return (
    <section aria-labelledby="dashboard-usage-heading" className={CARD}>
      <div className="flex items-center justify-between gap-4">
        <h2 id="dashboard-usage-heading" className="text-base font-semibold text-fg">
          Today&apos;s usage
        </h2>
        <Link href="/settings" className={HEADER_LINK}>
          Details
        </Link>
      </div>

      {quota.status === "error" ? (
        <p role="alert" className={`mt-4 ${ALERT}`}>
          Couldn&apos;t load your usage. See Settings for details.
        </p>
      ) : quota.data === null ? (
        <p className="mt-3 text-sm text-fg-muted">No daily limit applies to critiques right now.</p>
      ) : (
        <QuotaMeter quota={quota.data} />
      )}
    </section>
  );
}

function QuotaMeter({ quota }: { quota: CritiqueQuota }) {
  const percentLeft = quota.limit > 0 ? clampScore((quota.remaining / quota.limit) * 100) : 0;
  const exhausted = quota.remaining === 0;
  return (
    <div className="mt-3">
      <p className="text-sm font-medium text-fg">{quotaHeadline(quota)}</p>
      <div
        role="meter"
        aria-label="Critiques left today"
        aria-valuemin={0}
        aria-valuemax={quota.limit}
        aria-valuenow={quota.remaining}
        aria-valuetext={quotaHeadline(quota)}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-bg"
      >
        <div
          className={`h-full rounded-full ${exhausted ? "bg-danger-fg" : "bg-accent"}`}
          style={{ width: `${percentLeft}%` }}
        />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-fg-subtle">
        {exhausted
          ? "You've used today's critiques. They reset at 00:00 UTC."
          : "Shared with resume reports. Resets at 00:00 UTC."}
      </p>
    </div>
  );
}
