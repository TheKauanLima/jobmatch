"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "jobmatch-theme";

function subscribe(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

function getServerSnapshot(): Theme | null {
  return null;
}

/**
 * Explicit light/dark toggle. Reads the already-correct `data-theme`
 * attribute set by the anti-flash script in `app/layout.tsx` (never
 * re-derives from matchMedia/localStorage independently, so the toggle can
 * never disagree with what's actually rendered). Renders a neutral/disabled
 * state for the first server-rendered paint (before hydration) to avoid a
 * mismatch — see docs/ARCHITECTURE.md §6.4.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function applyTheme(next: Theme) {
    // Persisting the choice is best-effort — storage can throw (Safari
    // private mode, a third-party iframe, etc.). Still apply the DOM
    // attribute so the toggle works for the current page view even if it
    // won't survive a reload in that edge case.
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — see comment above
    }
    document.documentElement.setAttribute("data-theme", next);
  }

  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex items-center rounded-md border border-border-strong p-0.5 text-sm font-medium"
    >
      <button
        type="button"
        aria-label="Light theme"
        aria-pressed={theme === "light"}
        onClick={() => applyTheme("light")}
        disabled={theme === null}
        className={`rounded px-2 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          theme === "light"
            ? "bg-accent text-accent-fg"
            : "text-fg-muted hover:bg-surface-hover"
        }`}
      >
        Light
      </button>
      <button
        type="button"
        aria-label="Dark theme"
        aria-pressed={theme === "dark"}
        onClick={() => applyTheme("dark")}
        disabled={theme === null}
        className={`rounded px-2 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          theme === "dark"
            ? "bg-accent text-accent-fg"
            : "text-fg-muted hover:bg-surface-hover"
        }`}
      >
        Dark
      </button>
    </div>
  );
}
