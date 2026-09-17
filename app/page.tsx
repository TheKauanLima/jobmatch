import Link from "next/link";
import { FadeInSection } from "@/components/FadeInSection";
import { SampleAnalysisShowcase } from "@/components/SampleAnalysisShowcase";

/**
 * Landing page. Visual polish pass (2026-09-17): previously a single
 * heading + paragraph + CTA row with no structure below the fold — reads
 * like a placeholder rather than a finished product. Rebuilt as a proper
 * hero (eyebrow, headline, subheading, CTAs) plus a three-step "how it
 * works" section, still built entirely from the existing design tokens
 * (docs/ARCHITECTURE.md §6) — no new colors, no new components beyond
 * plain markup.
 *
 * Follow-up polish pass (2026-09-17, same day): added a static sample
 * resume/analysis showcase (`SampleAnalysisShowcase`) so the "AI analyzes
 * your resume" pitch is concrete rather than abstract, and wrapped each
 * section in `FadeInSection` so the page doesn't feel static while
 * scrolling.
 */

const STEPS = [
  {
    number: "1",
    title: "Upload your resume",
    description:
      "PDF, DOCX, or plain text. Your resume is private by default — it's never visible to other users or used to improve matching for anyone else.",
  },
  {
    number: "2",
    title: "Get an AI analysis",
    description:
      "Claude reads your resume and surfaces concrete strengths and weaknesses, plus roles it's well-suited for.",
  },
  {
    number: "3",
    title: "Match against real jobs",
    description:
      "See a score and rationale for how your resume stacks up against postings — shared community listings and real internship/entry-level roles pulled in automatically.",
  },
] as const;

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <FadeInSection as="section" className="mx-auto w-full max-w-5xl px-6 pt-20 pb-16 sm:pt-28 sm:pb-24">
        <p className="text-sm font-semibold tracking-wide text-fg-muted uppercase">
          AI-powered job matching
        </p>
        <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight text-fg sm:text-5xl">
          Know exactly how your resume stacks up.
        </h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-fg-muted sm:text-lg">
          Upload a resume, get an AI-powered strengths and weaknesses
          breakdown, and see how it matches against job descriptions — a mix
          of postings the community shares and internship/entry-level
          listings pulled in automatically for you.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/signup"
            className="inline-flex items-center justify-center rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Get started — it&apos;s free
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-md border border-border-strong bg-surface px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover"
          >
            Log in
          </Link>
        </div>
      </FadeInSection>

      <FadeInSection as="section" className="border-t border-border bg-surface">
        <div className="mx-auto w-full max-w-5xl px-6 py-16 sm:py-20">
          <h2 className="text-xl font-semibold tracking-tight text-fg">
            See it in action
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-fg-muted">
            A sample resume excerpt and the kind of analysis JobMatch
            generates for it — not real data, just an example.
          </p>
          <div className="mt-8">
            <SampleAnalysisShowcase />
          </div>
        </div>
      </FadeInSection>

      <FadeInSection as="section">
        <div className="mx-auto w-full max-w-5xl px-6 py-16 sm:py-20">
          <h2 className="text-xl font-semibold tracking-tight text-fg">
            How it works
          </h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {STEPS.map((step) => (
              <div
                key={step.number}
                className="rounded-lg border border-border bg-surface p-6 shadow-sm transition-shadow hover:shadow-md"
              >
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg">
                  {step.number}
                </span>
                <h3 className="mt-4 text-base font-semibold text-fg">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-fg-muted">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </FadeInSection>

      <FadeInSection as="section" className="mx-auto w-full max-w-5xl px-6 py-16 sm:py-20">
        <div className="rounded-lg border border-border bg-surface p-8 text-center shadow-sm sm:p-12">
          <h2 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">
            Ready to see how your resume measures up?
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
            Create a free account and upload your first resume in under a
            minute.
          </p>
          <div className="mt-6">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
            >
              Sign up
            </Link>
          </div>
        </div>
      </FadeInSection>
    </div>
  );
}
