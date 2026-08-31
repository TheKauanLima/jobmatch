const SCORE_BANDS = [
  { min: 75, style: "bg-success-bg text-success-fg", label: "Strong match" },
  { min: 50, style: "bg-warning-bg text-warning-fg", label: "Possible match" },
  { min: 0, style: "bg-danger-bg text-danger-fg", label: "Weak match" },
] as const;

function bandFor(score: number) {
  return SCORE_BANDS.find((band) => score >= band.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1];
}

interface MatchScoreBadgeProps {
  /** 0-100, per docs/ARCHITECTURE.md §1 (`matches.score`). */
  score: number;
  className?: string;
}

/**
 * Small badge showing a match's 0-100 score, color-banded by range using the
 * shared success/warning/danger tokens from docs/ARCHITECTURE.md §6 (no ad
 * hoc colors — see §6.1's reuse rule for match-score bands). Bands are
 * deliberately coarse (strong/possible/weak) to stay subtle/professional per
 * CLAUDE.md's design direction rather than a full gradient.
 */
export function MatchScoreBadge({ score, className = "" }: MatchScoreBadgeProps) {
  const band = bandFor(score);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${band.style} ${className}`}
      title={band.label}
    >
      {score}
      <span className="ml-0.5 font-normal opacity-80">/100</span>
    </span>
  );
}
