import Link from "next/link";
import { CritiqueSection } from "@/components/reports/CritiqueSection";
import {
  SAMPLE_CRITIQUE,
  SAMPLE_LINE_FEEDBACK_PREVIEW_COUNT,
} from "@/lib/marketing/sampleCritique";

/** What every critique includes, in the order the sample shows it. */
const INCLUDED = [
  "An overall score with a plain-language summary",
  "Your top 3 fixes, most impactful first",
  "Scores for impact, clarity, relevance, structure and ATS readability",
  "Line-by-line rewrites of your own bullets",
  "ATS issues and missing sections",
] as const;

/**
 * Landing-page "See what you get" showcase. Replaces the earlier mocked
 * resume/analysis pair (be97cf6) with the real critique view
 * (`CritiqueSection`, docs/ARCHITECTURE.md §13.20.6) rendered from a static,
 * clearly labelled FICTIONAL critique (`lib/marketing/sampleCritique.ts`),
 * so a logged-out visitor sees exactly what the feature looks like.
 *
 * Server component with no data access: no API call, no Claude, no DB. The
 * only client JS is what the critique components already ship (the copy
 * button in each line item and the line-list toggle).
 *
 * Heading outline: the caller's page has the `h1`; this renders the `h2`,
 * and `CritiqueSection` renders `h3`/`h4` beneath it. The "Sample critique"
 * label is a caption, not a heading, so it doesn't add an outline level.
 */
export function SampleCritiqueShowcase() {
  const total = SAMPLE_CRITIQUE.line_feedback.length;
  const shown = Math.min(SAMPLE_LINE_FEEDBACK_PREVIEW_COUNT, total);

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,9fr)] lg:gap-12">
      <div className="lg:sticky lg:top-8 lg:self-start">
        <p className="text-sm font-semibold tracking-wide text-fg-muted uppercase">
          Resume critique
        </p>
        <h2
          id="sample-critique-heading"
          className="mt-3 text-2xl font-semibold tracking-tight text-fg sm:text-3xl"
        >
          See what you get
        </h2>
        <p className="mt-4 text-base leading-7 text-fg-muted">
          This is the real critique view, filled in for a fictional computer
          engineering student. Upload your resume and you get the same
          detailed review of your own.
        </p>
        <ul className="mt-6 flex flex-col gap-2.5">
          {INCLUDED.map((item) => (
            <li key={item} className="flex items-start gap-2.5 text-sm leading-6 text-fg">
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="mt-1 h-4 w-4 shrink-0 text-success-fg"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 8.5l3 3 7-7" />
              </svg>
              {item}
            </li>
          ))}
        </ul>
        <div className="mt-8">
          <Link
            href="/signup"
            className="inline-flex items-center justify-center rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Get your own critique — free
          </Link>
          <p className="mt-3 text-xs leading-5 text-fg-subtle">
            Your resume and its critique are private to you.
          </p>
        </div>
      </div>

      <figure className="min-w-0 rounded-lg border border-border bg-surface p-4 shadow-sm sm:p-6"
      >
        <figcaption className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-4"
        >
          <span className="inline-flex items-center rounded-full bg-neutral-bg px-2.5 py-1 text-xs font-semibold text-neutral-fg">
            Sample critique · fictional resume
          </span>
          <span className="text-xs text-fg-subtle">
            Example only. Not a real person or resume.
          </span>
        </figcaption>
        <CritiqueSection
          critique={SAMPLE_CRITIQUE}
          showDate={false}
          lineFeedbackPreview={
            shown < total
              ? {
                  limit: shown,
                  note: (
                    <p>
                      Showing {shown} of {total} line suggestions.{" "}
                      <Link
                        href="/signup"
                        className="font-medium text-fg underline underline-offset-4 hover:text-fg-muted"
                      >
                        See the full critique after you sign up
                      </Link>
                      .
                    </p>
                  ),
                }
              : undefined
          }
        />
      </figure>
    </div>
  );
}
