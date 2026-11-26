/**
 * The single entry point every `job_descriptions` write path uses to derive
 * the board-filter facets (docs/ARCHITECTURE.md §7.8.4): field
 * (`job_category`), US states (`location_states`), and `is_remote`. Pure, no
 * Supabase import (the backfill lives in `lib/jobs/backfillFacets.ts`).
 *
 * Invariant: all three are written together; `job_category is null` means
 * "facets not computed yet".
 */

import type { JobCategory } from "@/lib/jobs/categories";
import { classifyJobCategory } from "@/lib/jobs/classifyCategory";
import { parseLocationFacets } from "@/lib/jobs/location";
import type { UsStateCode } from "@/lib/jobs/usStates";

export type JobFacets = {
  jobCategory: JobCategory;
  locationStates: UsStateCode[];
  isRemote: boolean;
};

export function deriveJobFacets(input: {
  title: string;
  location: string | null;
  department?: string | null;
  remoteHint?: boolean;
}): JobFacets {
  const { states, isRemote } = parseLocationFacets(input.location, {
    remote: input.remoteHint,
  });
  return {
    jobCategory: classifyJobCategory({
      title: input.title,
      department: input.department,
    }),
    locationStates: states,
    isRemote,
  };
}
