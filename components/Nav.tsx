"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ThemeToggle } from "@/components/ThemeToggle";

interface NavProps {
  userEmail: string | null;
}

export function Nav({ userEmail }: NavProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } finally {
      setSigningOut(false);
      router.push("/");
      router.refresh();
    }
  }

  return (
    <div className="flex items-center gap-6 text-sm font-medium text-fg-muted">
      {userEmail ? (
        <>
          <Link href="/dashboard" className="hover:text-fg">
            Dashboard
          </Link>
          <Link href="/resumes" className="hover:text-fg">
            Resumes
          </Link>
          <Link href="/jobs" className="hover:text-fg">
            Jobs
          </Link>
          <ThemeToggle />
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="rounded-md border border-border-strong px-3 py-1.5 text-fg-muted transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </>
      ) : (
        <>
          <Link href="/login" className="hover:text-fg">
            Log in
          </Link>
          <ThemeToggle />
          <Link
            href="/signup"
            className="rounded-md bg-accent px-3 py-1.5 text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Sign up
          </Link>
        </>
      )}
    </div>
  );
}
