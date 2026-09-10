"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ThemeToggle } from "@/components/ThemeToggle";

interface NavProps {
  userEmail: string | null;
}

/**
 * Primary nav links, collapsed behind a hamburger menu below the `sm:`
 * breakpoint (added per the 2026-09-10 UX pass — previously this rendered
 * every link/button in one un-wrapping flex row with no mobile fallback,
 * which either overflows or wraps uncontrolled on a phone-width screen, a
 * realistic device class for this audience). `ThemeToggle` and the primary
 * auth action (Sign out / Sign up) stay visible outside the collapsed menu
 * at every width; only the page links (plus Log in, secondary to Sign up)
 * move into the menu on mobile.
 */
export function Nav({ userEmail }: NavProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

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

  const navLinks = userEmail
    ? [
        { href: "/dashboard", label: "Dashboard" },
        { href: "/resumes", label: "Resumes" },
        { href: "/jobs", label: "Jobs" },
      ]
    : [{ href: "/login", label: "Log in" }];

  return (
    <div
      ref={menuRef}
      className="relative flex items-center gap-3 text-sm font-medium text-fg-muted sm:gap-6"
    >
      <div className="hidden items-center gap-6 sm:flex">
        {navLinks.map((link) => (
          <Link key={link.href} href={link.href} className="hover:text-fg">
            {link.label}
          </Link>
        ))}
      </div>

      <ThemeToggle />

      {userEmail ? (
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="hidden rounded-md border border-border-strong px-3 py-1.5 text-fg-muted transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60 sm:inline-flex"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      ) : (
        <Link
          href="/signup"
          className="hidden rounded-md bg-accent px-3 py-1.5 text-accent-fg transition-colors hover:bg-accent-hover sm:inline-flex"
        >
          Sign up
        </Link>
      )}

      <button
        type="button"
        aria-label={menuOpen ? "Close menu" : "Open menu"}
        aria-expanded={menuOpen}
        aria-controls="mobile-nav-menu"
        onClick={() => setMenuOpen((open) => !open)}
        className="inline-flex items-center justify-center rounded-md border border-border-strong p-2 text-fg-muted hover:bg-surface-hover sm:hidden"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="h-5 w-5"
        >
          {menuOpen ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 5l10 10M15 5L5 15"
            />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 5h14M3 10h14M3 15h14"
            />
          )}
        </svg>
      </button>

      {menuOpen && (
        <div
          id="mobile-nav-menu"
          className="absolute right-0 top-full z-10 mt-2 flex w-48 flex-col gap-1 rounded-md border border-border bg-surface p-2 shadow-lg sm:hidden"
        >
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className="rounded-md px-3 py-2 hover:bg-surface-hover hover:text-fg"
            >
              {link.label}
            </Link>
          ))}
          {userEmail ? (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                handleSignOut();
              }}
              disabled={signingOut}
              className="rounded-md px-3 py-2 text-left hover:bg-surface-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          ) : (
            <Link
              href="/signup"
              onClick={() => setMenuOpen(false)}
              className="rounded-md bg-accent px-3 py-2 text-center text-accent-fg hover:bg-accent-hover"
            >
              Sign up
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
