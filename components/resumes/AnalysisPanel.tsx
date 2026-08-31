import type { AnalysisPoint, ResumeAnalysis } from "@/types/domain";

interface AnalysisPanelProps {
  analysis: ResumeAnalysis | null;
}

/**
 * Displays a resume's latest AI analysis: summary, strengths/weaknesses
 * (each with a label + detail), and suggested roles as chips. Renders an
 * empty-state prompt when no analysis has been run yet — see
 * docs/ARCHITECTURE.md §2, `GET /api/resumes/:id/analysis` (404 = no
 * analysis yet, not an error).
 *
 * Pure display component — the "run analysis" action itself lives in
 * `AnalyzeResumeButton` (client component), rendered alongside this in
 * `app/resumes/[id]/page.tsx`.
 */
export function AnalysisPanel({ analysis }: AnalysisPanelProps) {
  if (!analysis) {
    return (
      <p className="text-sm text-fg-muted">
        No analysis yet. Run an AI analysis to see this resume&apos;s
        strengths, weaknesses, and suggested roles.
      </p>
    );
  }

  const { summary, strengths, weaknesses, suggested_roles } = analysis;

  return (
    <div className="flex flex-col gap-6">
      {summary && (
        <p className="text-sm leading-relaxed text-fg-muted">{summary}</p>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        <AnalysisPointList
          title="Strengths"
          points={strengths}
          badgeClassName="bg-success-bg text-success-fg"
          emptyLabel="No particular strengths called out."
        />
        <AnalysisPointList
          title="Areas to improve"
          points={weaknesses}
          badgeClassName="bg-warning-bg text-warning-fg"
          emptyLabel="No particular weaknesses called out."
        />
      </div>

      {suggested_roles.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-fg">
            Suggested roles
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {suggested_roles.map((role) => (
              <span
                key={role}
                className="inline-block rounded-full bg-neutral-bg px-3 py-1 text-xs font-medium text-neutral-fg"
              >
                {role}
              </span>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-fg-disabled">
        Analyzed {new Date(analysis.created_at).toLocaleString()}
      </p>
    </div>
  );
}

function AnalysisPointList({
  title,
  points,
  badgeClassName,
  emptyLabel,
}: {
  title: string;
  points: AnalysisPoint[];
  badgeClassName: string;
  emptyLabel: string;
}) {
  if (points.length === 0) {
    return (
      <div>
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <p className="mt-2 text-sm text-fg-subtle">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <ul className="mt-2 flex flex-col gap-3">
        {points.map((point, index) => (
          <li key={`${point.label}-${index}`}>
            <span
              className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${badgeClassName}`}
            >
              {point.label}
            </span>
            <p className="mt-1 text-sm text-fg-muted">{point.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
