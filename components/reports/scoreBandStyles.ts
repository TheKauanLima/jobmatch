import type { ScoreBandKey } from "@/lib/client/critique";

/**
 * §6 token classes for the three critique score bands (§13.20.6: the same
 * success/warning/danger tokens as `MatchScoreBadge`). Color is never the
 * only signal: every use also shows the score and the band label as text.
 */
export const BAND_BADGE: Record<ScoreBandKey, string> = {
  strong: "border-success-border bg-success-bg text-success-fg",
  polish: "border-warning-border bg-warning-bg text-warning-fg",
  work: "border-danger-border bg-danger-bg text-danger-fg",
};

/** Fill for bars and the score ring (uses `currentColor`). */
export const BAND_TEXT: Record<ScoreBandKey, string> = {
  strong: "text-success-fg",
  polish: "text-warning-fg",
  work: "text-danger-fg",
};

export const BAND_FILL: Record<ScoreBandKey, string> = {
  strong: "bg-success-fg",
  polish: "bg-warning-fg",
  work: "bg-danger-fg",
};
