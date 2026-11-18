import { clampScore, dimensionLabel, scoreBand } from "@/lib/client/critique";
import { ScoreBandBadge } from "@/components/reports/ScoreBandBadge";
import { BAND_FILL } from "@/components/reports/scoreBandStyles";
import type { CritiqueDimension } from "@/types/domain";

interface DimensionScoreCardProps {
  dimension: CritiqueDimension;
}

/**
 * One critique dimension (§13.20.6 content item 3): label, `NN/100` score
 * with its band label, a bar, the rationale, and "Fix:" `top_fix`. The bar
 * is decorative (`aria-hidden`); the score is always readable as text.
 * Presentational; reused unchanged by the M3.6 report page.
 */
export function DimensionScoreCard({ dimension }: DimensionScoreCardProps) {
  const label = dimensionLabel(dimension.dimension);
  const band = scoreBand(dimension.score);
  return (
    <article
      aria-label={`${label}: ${dimension.score} out of 100, ${band.label}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold text-fg">{label}</h4>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tabular-nums text-fg">
            {dimension.score}
            <span className="font-normal text-fg-subtle">/100</span>
          </span>
          <ScoreBandBadge score={dimension.score} />
        </div>
      </div>
      <div aria-hidden="true" className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-bg">
        <div
          className={`h-full rounded-full ${BAND_FILL[band.key]}`}
          style={{ width: `${clampScore(dimension.score)}%` }}
        />
      </div>
      <p className="text-sm leading-relaxed text-fg-muted">{dimension.rationale}</p>
      <p className="text-sm leading-relaxed text-fg">
        <span className="font-semibold">Fix: </span>
        {dimension.top_fix}
      </p>
    </article>
  );
}
