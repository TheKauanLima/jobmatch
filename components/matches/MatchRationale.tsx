import type { Match } from "@/types/domain";

interface MatchRationaleProps {
  match: Pick<Match, "rationale" | "matched_strengths" | "gaps">;
}

/**
 * Displays one match's rationale text plus its `matched_strengths`/`gaps`
 * lists (per docs/ARCHITECTURE.md §1, `matches` table), styled like
 * `AnalysisPanel.tsx`'s strengths/weaknesses layout for a consistent,
 * scannable pattern across the app.
 */
export function MatchRationale({ match }: MatchRationaleProps) {
  const { rationale, matched_strengths, gaps } = match;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-fg-muted">{rationale}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <MatchPointList
          title="Matched strengths"
          points={matched_strengths}
          dotClassName="bg-success-fg"
          emptyLabel="No specific strengths called out."
        />
        <MatchPointList
          title="Gaps"
          points={gaps}
          dotClassName="bg-warning-fg"
          emptyLabel="No specific gaps called out."
        />
      </div>
    </div>
  );
}

function MatchPointList({
  title,
  points,
  dotClassName,
  emptyLabel,
}: {
  title: string;
  points: string[];
  dotClassName: string;
  emptyLabel: string;
}) {
  if (points.length === 0) {
    return (
      <div>
        <h4 className="text-sm font-semibold text-fg">{title}</h4>
        <p className="mt-2 text-sm text-fg-subtle">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div>
      <h4 className="text-sm font-semibold text-fg">{title}</h4>
      <ul className="mt-2 flex flex-col gap-2">
        {points.map((point, index) => (
          <li key={index} className="flex items-start gap-2 text-sm text-fg-muted">
            <span
              className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClassName}`}
              aria-hidden="true"
            />
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
