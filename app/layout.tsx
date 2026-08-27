import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900">
        <header className="border-b border-zinc-200 bg-white">
          <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight text-zinc-900">
              JobMatch
            </Link>
            {/* Nav links (Dashboard, Resumes, Jobs, sign in/out) land with the auth milestone. */}
            <div className="flex items-center gap-6 text-sm font-medium text-zinc-600">
              <span className="cursor-default text-zinc-400">Dashboard</span>
              <span className="cursor-default text-zinc-400">Resumes</span>
              <span className="cursor-default text-zinc-400">Jobs</span>
            </div>
          </nav>
        </header>
        <main className="flex flex-1 flex-col">{children}</main>
        <footer className="border-t border-zinc-200 bg-white py-6">
          <div className="mx-auto max-w-5xl px-6 text-sm text-zinc-500">
            JobMatch
          </div>
        </footer>
      </body>
    </html>
  );
}
