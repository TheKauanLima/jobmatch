import Link from "next/link";

import { FirstRunWelcome } from "@/components/dashboard/FirstRunWelcome";
import { NextStepCard } from "@/components/dashboard/NextStepCard";
import { ResumeOverview } from "@/components/dashboard/ResumeOverview";
import { TopMatches } from "@/components/dashboard/TopMatches";
import { UsageSummary } from "@/components/dashboard/UsageSummary";
import { CARD, PRIMARY_LINK_BUTTON } from "@/components/dashboard/styles";
import { deriveNextSteps, type DashboardData } from "@/lib/client/dashboard";

interface DashboardViewProps {
  data: DashboardData;
}

const QUICK_LINKS = [
  { href: "/jobs", label: "Browse the job board" },
  { href: "/matches", label: "Match history" },
  { href: "/resumes", label: "Manage resumes" },
  { href: "/settings", label: "Settings and usage" },
] as const;

/**
 * The signed-in home (`/dashboard`): "where do I stand and what should I do
 * next?". Presentational: `app/dashboard/page.tsx` loads `data` through the
 * caller's session client. First-run users (no resumes) get a welcome with
 * one clear call to action instead of empty panels.
 */
export function DashboardView({ data }: DashboardViewProps) {
  const isFirstRun = data.resumes.status === "ok" && data.resumes.data.items.length === 0;
  const steps = deriveNextSteps(data);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            {isFirstRun ? "Welcome to Kalify" : "Welcome back"}
          </h1>
          <p className="mt-1 text-sm text-fg-muted">
            {isFirstRun
              ? "Your resume review and job matches will live here."
              : "Where you stand, and what to do next."}
          </p>
        </div>
        {!isFirstRun && data.resumes.status === "ok" && (
          <Link href="/resumes" className={`${PRIMARY_LINK_BUTTON} self-start sm:self-auto`}>
            <span aria-hidden="true">+</span> Upload a resume
          </Link>
        )}
      </header>

      <div className="mt-8">
        {isFirstRun ? <FirstRunWelcome /> : <NextStepCard steps={steps} />}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          {!isFirstRun && <ResumeOverview resumes={data.resumes} />}
          {!isFirstRun && <TopMatches matches={data.matches} />}
          {isFirstRun && <WhatYouGet />}
        </div>
        <aside className="flex min-w-0 flex-col gap-6" aria-label="Usage and shortcuts">
          <UsageSummary quota={data.quota} />
          <nav aria-labelledby="dashboard-shortcuts-heading" className={CARD}>
            <h2 id="dashboard-shortcuts-heading" className="text-base font-semibold text-fg">
              Shortcuts
            </h2>
            <ul className="mt-3 flex flex-col">
              {QUICK_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="-mx-2 flex items-center justify-between rounded-md px-2 py-2 text-sm text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    {link.label}
                    <span aria-hidden="true">&rarr;</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      </div>

      <p className="mt-8 flex items-center gap-2 text-xs text-fg-subtle">
        <LockIcon />
        Your resumes, critiques and matches are private to your account.
      </p>
    </div>
  );
}

/** First-run companion panel: what the critique covers, in plain terms. */
function WhatYouGet() {
  const items = [
    ["Overall score", "A 0–100 score with a plain-language summary."],
    ["Five focus areas", "Impact, clarity, relevance, structure and ATS readability."],
    ["Top 3 fixes", "The changes that will lift your score the most."],
    ["Line-by-line rewrites", "Suggested rewrites, with placeholders for your real numbers."],
  ] as const;
  return (
    <section aria-labelledby="what-you-get-heading" className={CARD}>
      <h2 id="what-you-get-heading" className="text-base font-semibold text-fg">
        What your critique includes
      </h2>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        {items.map(([term, description]) => (
          <div key={term}>
            <dt className="text-sm font-medium text-fg">{term}</dt>
            <dd className="mt-0.5 text-sm leading-relaxed text-fg-muted">{description}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}
