"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

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
    <div className="flex items-center gap-6 text-sm font-medium text-zinc-600">
      {userEmail ? (
        <>
          <Link href="/dashboard" className="hover:text-zinc-900">
            Dashboard
          </Link>
          <span className="cursor-default text-zinc-400">Resumes</span>
          <span className="cursor-default text-zinc-400">Jobs</span>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </>
      ) : (
        <>
          <Link href="/login" className="hover:text-zinc-900">
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-white transition-colors hover:bg-zinc-700"
          >
            Sign up
          </Link>
        </>
      )}
    </div>
  );
}
