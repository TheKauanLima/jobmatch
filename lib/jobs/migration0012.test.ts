import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { JOB_CATEGORY_SLUGS } from "@/lib/jobs/categories";
import { US_STATE_CODES } from "@/lib/jobs/usStates";

/**
 * QA: the 0012 check constraints must list exactly the values the TS code
 * writes (lib/jobs/categories.ts, lib/jobs/usStates.ts). A drift means every
 * insert/upsert carrying the missing value fails at the DB.
 */
const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/0012_job_board_filters.sql"),
  "utf8",
);

function quotedValues(fragment: string): string[] {
  return [...fragment.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("migration 0012 constraints match the TS constants", () => {
  it("job_category check lists exactly JOB_CATEGORY_SLUGS", () => {
    const fragment = /job_descriptions_job_category_check\s+check\s*\(job_category in \(([\s\S]*?)\)\)/.exec(sql)?.[1];
    expect(fragment).toBeDefined();
    expect(quotedValues(fragment!).sort()).toEqual([...JOB_CATEGORY_SLUGS].sort());
  });

  it("location_states check lists exactly US_STATE_CODES (50 states + DC)", () => {
    const fragment = /job_descriptions_location_states_check\s+check\s*\(location_states <@ array\[([\s\S]*?)\]/.exec(sql)?.[1];
    expect(fragment).toBeDefined();
    const codes = quotedValues(fragment!);
    expect(codes).toHaveLength(51);
    expect(codes.sort()).toEqual([...US_STATE_CODES].sort());
  });

  it("revokes the facets function from anon and grants it to authenticated", () => {
    expect(sql).toMatch(/revoke execute on function public\.job_description_facets\(\) from public, anon;/);
    expect(sql).toMatch(/grant execute on function public\.job_description_facets\(\) to authenticated, service_role;/);
  });

  it("keeps the search function security invoker with an empty search_path and the deleted_at filter", () => {
    const fn = /create function public\.search_job_descriptions\([\s\S]*?\$\$;/.exec(sql)?.[0] ?? "";
    expect(fn).toMatch(/security invoker set search_path = ''/);
    expect(fn).toMatch(/deleted_at is null/);
    // Old 4-arg named call (search_query, level_filter, limit_count, offset_count) still resolves.
    for (const param of ["category_filter", "state_filter", "remote_only", "sort_mode", "limit_count", "offset_count"]) {
      expect(fn).toMatch(new RegExp(`${param}\\s+\\w+\\s+default`));
    }
  });
});
