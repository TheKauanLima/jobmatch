import { MatchScoreBadge } from "@/components/matches/MatchScoreBadge";

/**
 * Static, clearly-labeled mockup for the landing page that makes the "AI
 * analyzes your resume" pitch concrete for a logged-out visitor. Not a
 * functional demo — no upload, no API call, entirely invented placeholder
 * content. Reuses `MatchScoreBadge` and the strength/weakness badge visual
 * language already established in `AnalysisPanel` (components/resumes) for
 * consistency with the rest of the app.
 */
export function SampleAnalysisShowcase() {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div className="rounded-lg border border-border bg-bg p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center rounded-full bg-neutral-bg px-2.5 py-1 text-xs font-semibold text-neutral-fg">
            Example resume
          </span>
        </div>
        <p className="mt-4 text-sm font-semibold text-fg">Jordan Rivera</p>
        <p className="text-xs text-fg-subtle">
          Computer Science student — expected graduation 2027
        </p>
        <div className="mt-4">
          <p className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Experience
          </p>
          <ul className="mt-2 flex flex-col gap-2 text-sm leading-6 text-fg-muted">
            <li>
              Built and shipped a small internal tool used by a 5-person team,
              cutting a manual weekly task from an hour to a few minutes.
            </li>
            <li>
              Contributed to a group course project deploying a web app with
              a relational database and a REST API.
            </li>
            <li>
              Teaching assistant for an intro programming course, holding
              weekly office hours for ~30 students.
            </li>
          </ul>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-bg p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center rounded-full bg-neutral-bg px-2.5 py-1 text-xs font-semibold text-neutral-fg">
            Example AI analysis
          </span>
          <MatchScoreBadge score={78} />
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <div>
            <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-success-bg text-success-fg">
              Strength
            </span>
            <p className="mt-1 text-sm text-fg-muted">
              Hands-on project experience with a real, deployed full-stack
              app — stands out for an entry-level candidate.
            </p>
          </div>
          <div>
            <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-warning-bg text-warning-fg">
              Area to improve
            </span>
            <p className="mt-1 text-sm text-fg-muted">
              No measurable impact listed for the teaching assistant role —
              add a number (students helped, sessions run).
            </p>
          </div>
        </div>
        <p className="mt-4 text-xs text-fg-disabled">
          Illustrative example — not a real resume or user.
        </p>
      </div>
    </div>
  );
}
