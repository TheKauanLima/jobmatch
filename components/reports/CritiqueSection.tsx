import type { ReactNode } from "react";
import { CritiquePriorities } from "@/components/reports/CritiquePriorities";
import { DimensionScoreCard } from "@/components/reports/DimensionScoreCard";
import { LineFeedbackList } from "@/components/reports/LineFeedbackList";
import { ScoreBandBadge } from "@/components/reports/ScoreBandBadge";
import { BAND_TEXT } from "@/components/reports/scoreBandStyles";
import {
  CRITIQUE_COPY,
  clampScore,
  formatCritiqueDate,
  scoreBand,
  studentStageLabel,
} from "@/lib/client/critique";
import type { Critique } from "@/types/domain";

interface CritiqueSectionProps {
  critique: Critique;
  /**
   * Rendered inside the "An updated critique is available" note when
   * `is_current` is false (V1: the `RunCritiqueButton`). Omit it where no
   * re-run is offered (e.g. the M3.6 report page).
   */
  staleAction?: ReactNode;
  /**
   * Showcase mode (landing page): show only the first `limit` line-feedback
   * items, followed by `note`, instead of the full list with its "Show all
   * N" toggle. Omit it (the default) for the full list.
   */
  lineFeedbackPreview?: { limit: number; note: ReactNode };
  /**
   * Show the "Generated <date>" line in the footer. Defaults to `true`; the
   * landing-page sample turns it off because its date is not meaningful.
   * The AI disclaimer always shows.
   */
  showDate?: boolean;
}

/**
 * The full resume critique (docs/ARCHITECTURE.md §13.20.6), in the binding
 * content order: overall score + summary, Top 3 priorities, the five
 * dimension cards, line-by-line feedback, ATS issues and missing sections,
 * then the AI disclaimer and date. `section_feedback` is not shown in V1.
 *
 * Presentational and shared: the V1 resume page and (M3.6) the report page
 * both pass a `Critique` from the API. Every Claude- or resume-derived
 * string renders as React text, never HTML. Headings start at `h3`; the
 * caller owns the `h2` card title.
 */
export function CritiqueSection({
  critique,
  staleAction,
  lineFeedbackPreview,
  showDate = true,
}: CritiqueSectionProps) {
  const date = showDate ? formatCritiqueDate(critique.created_at) : null;
  const lineItems = lineFeedbackPreview
    ? critique.line_feedback.slice(0, Math.max(0, lineFeedbackPreview.limit))
    : critique.line_feedback;

  return (
    <div className="flex flex-col gap-8">
      {!critique.is_current && (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-bg px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-fg-muted">{CRITIQUE_COPY.stale}</p>
          {staleAction}
        </div>
      )}

      <OverallScore critique={critique} />

      {critique.priorities.length > 0 && (
        <section aria-labelledby={`${critique.id}-priorities`}>
          <h3 id={`${critique.id}-priorities`} className="text-sm font-semibold text-fg">
            Top {critique.priorities.length} priorities
          </h3>
          <p className="mt-1 text-sm text-fg-subtle">Start here: the fixes that will lift your score most.</p>
          <div className="mt-3">
            <CritiquePriorities priorities={critique.priorities} />
          </div>
        </section>
      )}

      <section aria-labelledby={`${critique.id}-dimensions`}>
        <h3 id={`${critique.id}-dimensions`} className="text-sm font-semibold text-fg">
          Scores by area
        </h3>
        <div className="mt-3 flex flex-col gap-3">
          {critique.dimensions.map((dimension) => (
            <DimensionScoreCard key={dimension.dimension} dimension={dimension} />
          ))}
        </div>
      </section>

      <section aria-labelledby={`${critique.id}-lines`}>
        <h3 id={`${critique.id}-lines`} className="text-sm font-semibold text-fg">
          Line-by-line feedback
        </h3>
        <p className="mt-1 text-sm text-fg-subtle">
          Your original line, what to change, and a suggested rewrite. Most impactful first.
        </p>
        <div className="mt-4">
          <LineFeedbackList items={lineItems} />
        </div>
        {lineFeedbackPreview && (
          <div className="mt-4 rounded-md border border-dashed border-border-strong bg-bg px-4 py-3 text-sm text-fg-muted">
            {lineFeedbackPreview.note}
          </div>
        )}
      </section>

      <div className="grid gap-6 sm:grid-cols-2">
        <section aria-labelledby={`${critique.id}-ats`}>
          <h3 id={`${critique.id}-ats`} className="text-sm font-semibold text-fg">
            ATS issues
          </h3>
          {critique.ats_issues.length === 0 ? (
            <p className="mt-2 text-sm text-fg-subtle">No ATS issues found.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3">
              {critique.ats_issues.map((item, index) => (
                <li key={index} className="text-sm leading-relaxed">
                  <p className="text-fg">{item.issue}</p>
                  <p className="text-fg-muted">
                    <span className="font-medium text-fg">Fix: </span>
                    {item.fix}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby={`${critique.id}-missing`}>
          <h3 id={`${critique.id}-missing`} className="text-sm font-semibold text-fg">
            Missing sections
          </h3>
          {critique.missing_sections.length === 0 ? (
            <p className="mt-2 text-sm text-fg-subtle">No missing sections.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {critique.missing_sections.map((section, index) => (
                <li key={index} className="flex items-start gap-2 text-sm text-fg">
                  <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-fg-subtle" />
                  {section}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="border-t border-border pt-4 text-xs leading-relaxed text-fg-subtle">
        <p>{CRITIQUE_COPY.footer}</p>
        {date && (
          <p className="mt-1">
            Generated <time dateTime={critique.created_at}>{date}</time>
          </p>
        )}
      </footer>
    </div>
  );
}

const RING_RADIUS = 42;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function OverallScore({ critique }: { critique: Critique }) {
  const band = scoreBand(critique.overall_score);
  const dash = (clampScore(critique.overall_score) / 100) * RING_CIRCUMFERENCE;
  const note = critique.student_context?.note;
  const stage = critique.student_context?.stage;

  return (
    <section
      aria-labelledby={`${critique.id}-overall`}
      className="flex flex-col gap-5 rounded-lg border border-border bg-bg p-4 sm:flex-row sm:items-center sm:gap-6 sm:p-5"
    >
      <h3 id={`${critique.id}-overall`} className="sr-only">
        Overall score
      </h3>
      <div className="flex items-center gap-4 sm:flex-col sm:gap-2">
        <div className="relative h-24 w-24 shrink-0 sm:h-28 sm:w-28">
          <svg aria-hidden="true" viewBox="0 0 100 100" className="h-full w-full -rotate-90">
            <circle cx="50" cy="50" r={RING_RADIUS} fill="none" strokeWidth="8" className="stroke-current text-neutral-bg" />
            <circle
              cx="50"
              cy="50"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${RING_CIRCUMFERENCE}`}
              className={`stroke-current ${BAND_TEXT[band.key]}`}
            />
          </svg>
          <p className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-3xl font-semibold leading-none tabular-nums text-fg">
              {critique.overall_score}
            </span>
            <span className="mt-0.5 text-xs text-fg-subtle">/100</span>
            <span className="sr-only"> overall, {band.label}</span>
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-center">
          <span className="text-xs font-medium text-fg-subtle sm:hidden">Overall score</span>
          <ScoreBandBadge score={critique.overall_score} />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed text-fg">{critique.summary}</p>
        {note && (
          <div className="mt-3 border-t border-border pt-3">
            {stage && (
              <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
                {studentStageLabel(stage)}
              </p>
            )}
            <p className="mt-1 text-sm leading-relaxed text-fg-muted">{note}</p>
          </div>
        )}
      </div>
    </section>
  );
}
