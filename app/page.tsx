import Link from "next/link";

/**
 * Landing page CTAs, added per the 2026-09-10 UX pass — previously the only
 * way for a logged-out visitor to sign up or log in was the header nav
 * (`components/Nav.tsx`), with no on-page action here at all.
 */
export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-start justify-center px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight text-fg">
        JobMatch
      </h1>
      <p className="mt-3 max-w-xl text-base leading-7 text-fg-muted">
        Upload a resume, get an AI-powered strengths/weaknesses breakdown, and
        see how it matches against job descriptions — a mix of postings the
        community shares and internship/entry-level listings pulled in
        automatically for you.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <Link
          href="/signup"
          className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
        >
          Sign up
        </Link>
        <Link
          href="/login"
          className="inline-flex items-center justify-center rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface-hover"
        >
          Log in
        </Link>
      </div>
    </div>
  );
}
