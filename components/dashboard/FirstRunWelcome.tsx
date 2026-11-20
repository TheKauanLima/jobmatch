import Link from "next/link";

import { CARD, PRIMARY_LINK_BUTTON } from "@/components/dashboard/styles";

const STEPS = [
  {
    title: "Upload your resume",
    body: "A PDF or DOCX. It stays private to your account.",
  },
  {
    title: "Get a detailed critique",
    body: "An overall score, scores for five areas, your top 3 fixes and line-by-line rewrites.",
  },
  {
    title: "Match it against real jobs",
    body: "See how well you fit a listing, what you already cover and what's missing.",
  },
] as const;

/**
 * First-run state for a signed-in user with no resumes: a short welcome,
 * the three steps of the flow, and one clear call to action.
 */
export function FirstRunWelcome() {
  return (
    <section aria-labelledby="first-run-heading" className={`${CARD} border-border-strong`}>
      <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Start here</p>
      <h2 id="first-run-heading" className="mt-1 text-xl font-semibold tracking-tight text-fg">
        Let&apos;s see where your resume stands
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted">
        Kalify reviews your resume the way a recruiter would, then shows you how it compares
        with real job listings. It takes about a minute to get your first critique.
      </p>

      <ol className="mt-6 grid gap-3 sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3 rounded-lg border border-border bg-bg p-4">
            <span
              aria-hidden="true"
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                index === 0 ? "bg-accent text-accent-fg" : "border border-border-strong text-fg-muted"
              }`}
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">
                <span className="sr-only">Step {index + 1}: </span>
                {step.title}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-fg-muted">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
        <Link href="/resumes" className={`${PRIMARY_LINK_BUTTON} self-start`}>
          Upload your resume
          <span aria-hidden="true">&rarr;</span>
        </Link>
        <p className="text-xs text-fg-subtle">
          Only you can see your resume and its results.
        </p>
      </div>
    </section>
  );
}
