"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

interface FadeInSectionProps {
  children: ReactNode;
  className?: string;
  /** Element type to render as. Defaults to `div` so this can wrap any block-level content. */
  as?: "div" | "section";
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(callback: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function getReducedMotionSnapshot() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

// Assume motion is fine for the server-rendered pass — matches the
// no-JS/pre-hydration fallback already accepted elsewhere in this app (see
// ThemeToggle's getServerSnapshot in docs/ARCHITECTURE.md §6.4). The real
// preference is read via `subscribeReducedMotion`/`getReducedMotionSnapshot`
// as soon as the component mounts on the client.
function getReducedMotionServerSnapshot() {
  return false;
}

/**
 * Wraps a landing-page section so it fades/slides in the first time it
 * scrolls into view, instead of just appearing. Dependency-free by design
 * (CLAUDE.md: "clarity over flourish") — a single IntersectionObserver plus
 * a CSS transition, no animation library.
 *
 * Respects `prefers-reduced-motion`: when set, content renders fully visible
 * immediately with no transition at all, per accessibility requirements.
 */
export function FadeInSection({
  children,
  className = "",
  as = "div",
}: FadeInSectionProps) {
  const divRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );

  useEffect(() => {
    if (reducedMotion) return;

    const node = as === "section" ? sectionRef.current : divRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [reducedMotion, as]);

  const isVisible = reducedMotion || visible;
  const motionClassName = `${
    reducedMotion
      ? ""
      : `transition-all duration-700 ease-out ${
          isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
        }`
  } ${className}`;

  if (as === "section") {
    return (
      <section ref={sectionRef} className={motionClassName}>
        {children}
      </section>
    );
  }

  return (
    <div ref={divRef} className={motionClassName}>
      {children}
    </div>
  );
}
