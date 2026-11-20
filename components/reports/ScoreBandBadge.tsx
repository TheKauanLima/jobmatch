import { scoreBand } from "@/lib/client/critique";
import { BAND_BADGE } from "@/components/reports/scoreBandStyles";

interface ScoreBandBadgeProps {
  score: number;
  className?: string;
}

/** Pill with the band label ("Strong" / "Needs polish" / "Needs work") as text. */
export function ScoreBandBadge({ score, className = "" }: ScoreBandBadgeProps) {
  const band = scoreBand(score);
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${BAND_BADGE[band.key]} ${className}`}
    >
      {band.label}
    </span>
  );
}
