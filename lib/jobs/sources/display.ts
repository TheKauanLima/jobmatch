import type { JobDescriptionSource } from "@/types/database";

/**
 * Display names and attribution for every `job_descriptions.source`
 * (docs/ARCHITECTURE.md §13.6.7, §13.13.4: `source_display_name` and
 * `attribution` on every listing).
 *
 * Kept dependency-free (no adapter code, no fetch) because
 * `types/domain.ts#toJobDescription` imports it and that module is shared
 * with client components. Adapters take their `displayName` / `attribution`
 * from here, so there is one source of truth.
 */

export type SourceAttribution = { text: string; url: string };

export type SourceDisplay = {
  displayName: string;
  attribution: SourceAttribution | null;
};

export const SOURCE_DISPLAY: Readonly<Record<JobDescriptionSource, SourceDisplay>> = {
  user: { displayName: "Submitted by a Kalify user", attribution: null },
  // The Muse's terms require a link back on every listing (§7.1); the card
  // links to source_url (the Muse landing page) and shows this attribution.
  themuse: {
    displayName: "The Muse",
    attribution: { text: "Listing from The Muse", url: "https://www.themuse.com" },
  },
  usajobs: { displayName: "USAJOBS", attribution: null },
  greenhouse: { displayName: "Greenhouse", attribution: null },
  lever: { displayName: "Lever", attribution: null },
  // Adzuna requires attribution on every page showing its data (§13.6.1).
  adzuna: {
    displayName: "Adzuna",
    attribution: { text: "Jobs by Adzuna", url: "https://www.adzuna.com" },
  },
};

export function getSourceDisplay(source: JobDescriptionSource): SourceDisplay {
  return SOURCE_DISPLAY[source] ?? { displayName: source, attribution: null };
}
