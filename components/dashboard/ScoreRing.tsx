import { BAND_TEXT } from "@/components/reports/scoreBandStyles";
import { clampScore, scoreBand } from "@/lib/client/critique";

const RADIUS = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface ScoreRingProps {
  /** Overall critique score, or `null` for "no critique yet" (a dashed empty ring). */
  score: number | null;
  className?: string;
}

/**
 * Small critique score ring for lists (the full-size ring lives in
 * `CritiqueSection`). Uses the §13.20.6 band tokens; the number is always
 * shown as text and the band is announced to screen readers, so color is
 * never the only signal.
 */
export function ScoreRing({ score, className = "" }: ScoreRingProps) {
  if (score === null) {
    return (
      <div
        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-border-strong text-sm font-medium text-fg-subtle ${className}`}
      >
        <span aria-hidden="true">&ndash;</span>
        <span className="sr-only">No critique yet</span>
      </div>
    );
  }

  const band = scoreBand(score);
  const dash = (clampScore(score) / 100) * CIRCUMFERENCE;
  return (
    <div className={`relative h-12 w-12 shrink-0 ${className}`}>
      <svg aria-hidden="true" viewBox="0 0 48 48" className="h-full w-full -rotate-90">
        <circle cx="24" cy="24" r={RADIUS} fill="none" strokeWidth="4" className="stroke-current text-neutral-bg" />
        <circle
          cx="24"
          cy="24"
          r={RADIUS}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
          className={`stroke-current ${BAND_TEXT[band.key]}`}
        />
      </svg>
      <p className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums text-fg">
        {score}
        <span className="sr-only">/100, {band.label}</span>
      </p>
    </div>
  );
}
