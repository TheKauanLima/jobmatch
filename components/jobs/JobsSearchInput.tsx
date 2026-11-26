"use client";

import { useState } from "react";
import { JOBS_SEARCH_MAX_LENGTH } from "@/lib/client/jobsBoard";

/**
 * The `/jobs` search box (`name="q"` inside the `next/form` in
 * `JobsSearchControls`). Controlled, and synced to the URL's `q` when that
 * changes ("Clear all", a chip, back/forward) by adjusting state during
 * render, never by remounting, so focus and the caret stay put while the
 * user is in the box.
 */
export function JobsSearchInput({ q }: { q: string | null }) {
  const urlValue = q ?? "";
  const [value, setValue] = useState(urlValue);
  const [syncedFrom, setSyncedFrom] = useState(urlValue);
  if (syncedFrom !== urlValue) {
    setSyncedFrom(urlValue);
    setValue(urlValue);
  }

  return (
    <input
      id="job-search"
      name="q"
      type="search"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      placeholder="Search title, company, location, or keyword"
      maxLength={JOBS_SEARCH_MAX_LENGTH}
      autoComplete="off"
      enterKeyHint="search"
      className="min-h-11 w-full rounded-md border border-border-strong bg-surface sm:min-h-0 py-2.5 pl-9 pr-3 text-sm text-fg shadow-sm transition-colors placeholder:text-fg-subtle focus:border-fg-subtle focus:outline-none focus:ring-1 focus:ring-fg-subtle"
    />
  );
}
