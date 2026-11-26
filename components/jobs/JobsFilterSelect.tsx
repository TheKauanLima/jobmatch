"use client";

import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  buildJobsHref,
  withJobsParam,
  type JobsBoardQuery,
  type JobsFilterKey,
  type JobsSelectOption,
} from "@/lib/client/jobsBoard";

interface JobsFilterSelectProps {
  /** Which URL param this select controls. */
  param: JobsFilterKey | "sort";
  /** Visible label text. */
  label: string;
  /** Current value from the URL (`""` for "any"). */
  value: string;
  options: readonly JobsSelectOption[];
  /** The full current query, so changing this select keeps every other param. */
  query: JobsBoardQuery;
  className?: string;
}

/**
 * One board filter as a native `<select>` with a visible `<label>`
 * (docs/ARCHITECTURE.md §7.8.7). Native so keyboard, screen-reader and
 * mobile pickers all behave as users expect.
 *
 * On change it navigates to the same `/jobs` URL with only this param
 * replaced (`withJobsParam` re-parses, so a bad value can't leak into the
 * URL).
 *
 * Focus: the select is never remounted on a URL change (the parent gives it
 * a stable key per filter), so keyboard focus stays on it after navigating.
 * That matters because on Windows Chrome/Edge an arrow key on a closed
 * select fires `change` straight away (WCAG 2.4.3 / 3.2.2). The value is
 * controlled: the URL value (`value`), overridden by the user's choice only
 * while that navigation is in flight (`useOptimistic` drops the override
 * when the transition ends, by which time `value` has caught up). So it
 * also follows back/forward navigation without a remount.
 */
export function JobsFilterSelect({
  param,
  label,
  value,
  options,
  query,
  className = "",
}: JobsFilterSelectProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [current, setOptimistic] = useOptimistic(value);
  const id = `jobs-filter-${param}`;

  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <label
        htmlFor={id}
        className="text-xs font-semibold uppercase tracking-wide text-fg-subtle"
      >
        {label}
      </label>
      <select
        id={id}
        name={param}
        value={current}
        aria-busy={pending || undefined}
        onChange={(event) => {
          const next = event.target.value;
          startTransition(() => {
            setOptimistic(next);
            router.push(buildJobsHref(withJobsParam(query, param, next)), {
              scroll: false,
            });
          });
        }}
        className="min-h-11 w-full min-w-0 rounded-md border sm:min-h-0 border-border-strong bg-surface py-2 pl-3 pr-8 text-sm text-fg shadow-sm transition-colors hover:border-fg-subtle focus:border-fg-subtle focus:outline-none focus:ring-1 focus:ring-fg-subtle"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
