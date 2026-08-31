import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Nav } from "@/components/Nav";
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
        <footer className="border-t border-border bg-surface py-6">
          <div className="mx-auto max-w-5xl px-6 text-sm text-fg-subtle">
            JobMatch
          </div>
        </footer>
      </body>
    </html>
  );
}
