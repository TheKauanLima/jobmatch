import Link from "next/link";

import { ScoreRing } from "@/components/dashboard/ScoreRing";
import { CARD, PRIMARY_LINK_BUTTON } from "@/components/dashboard/styles";
import { nextStepContent, type NextStep, type NextSteps } from "@/lib/client/dashboard";

interface NextStepCardProps {
  steps: NextSteps;
}

/** The score shown beside the primary step, when it has one. */
function stepScore(step: NextStep): number | null {
  if (step.kind === "fix_priority") return step.score;
  if (step.kind === "view_matches") return step.match.score;
  return null;
}

/**
 * "Your next step": the single most useful action derived by
 * `deriveNextSteps`, plus up to two lighter follow-ups. Model text (a
 * priority's fix) renders as plain React text.
 */
export function NextStepCard({ steps }: NextStepCardProps) {
  const { primary, followUps } = steps;
  const content = nextStepContent(primary);
  const score = stepScore(primary);

  return (
    <section aria-labelledby="next-step-heading" className={`${CARD} border-border-strong`}>
      <h2 id="next-step-heading" className="text-sm font-semibold text-fg-muted">
        Your next step
      </h2>

      <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="flex min-w-0 gap-4">
          {score !== null && <ScoreRing score={score} className="hidden sm:block" />}
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
              {content.eyebrow}
            </p>
            <p className="mt-1 text-lg font-semibold leading-snug text-fg [overflow-wrap:anywhere]">
              {content.title}
            </p>
            {content.body && (
              <p className="mt-2 text-sm leading-relaxed text-fg-muted [overflow-wrap:anywhere]">
                {content.body}
              </p>
            )}
          </div>
        </div>
        {content.cta && (
          <Link href={content.cta.href} className={`${PRIMARY_LINK_BUTTON} shrink-0 self-start`}>
            {content.cta.label}
            <span aria-hidden="true">&rarr;</span>
          </Link>
        )}
      </div>

      {followUps.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-fg-subtle">After that</h3>
          <ul className="mt-2 flex flex-col divide-y divide-border">
            {followUps.map((step, index) => {
              const followUp = nextStepContent(step);
              return (
                <li
                  key={`${step.kind}-${index}`}
                  className="flex flex-col gap-2 py-3 first:pt-1 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-fg-subtle">{followUp.eyebrow}</p>
                    <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{followUp.title}</p>
                    {followUp.body && (
                      <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{followUp.body}</p>
                    )}
                  </div>
                  {followUp.cta && (
                    <Link
                      href={followUp.cta.href}
                      className="shrink-0 rounded-sm text-sm font-medium text-fg underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {followUp.cta.label} <span aria-hidden="true">&rarr;</span>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
