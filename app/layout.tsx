import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { FadeInSection } from "@/components/FadeInSection";
import { getSession } from "@/lib/auth/session";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "JobMatch",
  description: "Match your resume against job descriptions with AI-powered analysis.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Best-effort session read for the nav's logged-in state. Falls back to
  // "logged out" rendering rather than crashing the whole app if Supabase
  // isn't reachable/configured (e.g. no env vars set locally yet).
  let userEmail: string | null = null;
  try {
    const session = await getSession();
    userEmail = session?.user.email ?? null;
  } catch {
    userEmail = null;
  }

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('jobmatch-theme');var t=s==='light'||s==='dark'?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-bg text-fg">
        <header className="border-b border-border bg-surface">
          <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight text-fg">
              JobMatch
            </Link>
            <Nav userEmail={userEmail} />
          </nav>
        </header>
        <main className="flex flex-1 flex-col">{children}</main>
        <FadeInSection>
          <SiteFooter userEmail={userEmail} />
        </FadeInSection>
      </body>
    </html>
  );
}

const FOOTER_LINK_GROUPS: Record<
  "loggedIn" | "loggedOut",
  { href: string; label: string }[]
> = {
  loggedIn: [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/resumes", label: "Resumes" },
    { href: "/jobs", label: "Jobs" },
  ],
  loggedOut: [
    { href: "/login", label: "Log in" },
    { href: "/signup", label: "Sign up" },
  ],
};

/**
 * Site footer. Replaces the previous bare "JobMatch" text with a proper
 * footer per the 2026-09-17 visual polish pass: brand mark, one-line
 * description (adapted from the landing hero copy), session-aware links
 * (same auth-state pattern `Nav.tsx` uses), a copyright line computed at
 * render (not hardcoded), and a link to the public GitHub repo — this is an
 * open student project, not a company, so no invented About/Careers/Privacy
 * links to pages that don't exist.
 */
function SiteFooter({ userEmail }: { userEmail: string | null }) {
  const links = userEmail
    ? FOOTER_LINK_GROUPS.loggedIn
    : FOOTER_LINK_GROUPS.loggedOut;
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-surface py-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-sm">
          <p className="text-base font-semibold tracking-tight text-fg">
            JobMatch
          </p>
          <p className="mt-2 text-sm leading-6 text-fg-muted">
            AI-powered resume analysis and job matching — upload a resume,
            get a strengths and weaknesses breakdown, and see how it stacks
            up against real postings.
          </p>
        </div>

        <div className="flex flex-col gap-3 text-sm sm:flex-row sm:gap-10">
          <div className="flex flex-col gap-2">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-fg-muted transition-colors hover:text-fg"
              >
                {link.label}
              </Link>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <a
              href="https://github.com/TheKauanLima/jobmatch"
              target="_blank"
              rel="noreferrer noopener"
              className="text-fg-muted transition-colors hover:text-fg"
            >
              GitHub
            </a>
          </div>
        </div>
      </div>

      <div className="mx-auto mt-8 max-w-5xl px-6">
        <p className="text-xs text-fg-subtle">
          &copy; {year} JobMatch. An open student project.
        </p>
      </div>
    </footer>
  );
}
