import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH,
  JOB_DESCRIPTIONS_DEFAULT_LIMIT,
  JOB_DESCRIPTIONS_MAX_LIMIT,
} from "@/lib/jobs/listLimits";
import * as queries from "@/lib/supabase/queries/jobDescriptions";

/**
 * lib/jobs/listLimits.ts is imported by lib/validation/schemas.ts, which
 * client components import. It must stay import-free so it never drags a
 * server module into the client bundle (docs/ARCHITECTURE.md §7.8.8).
 */
describe("lib/jobs/listLimits.ts", () => {
  const source = readFileSync(join(process.cwd(), "lib/jobs/listLimits.ts"), "utf8");

  it("has no import statements, dynamic imports, or require calls", () => {
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/^\s*export\s+(\*|\{[^}]*\})\s+from\b/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it("is what lib/validation/schemas.ts imports the limits from (not the query module)", () => {
    const schemas = readFileSync(join(process.cwd(), "lib/validation/schemas.ts"), "utf8");
    expect(schemas).toContain('from "@/lib/jobs/listLimits"');
    expect(schemas).not.toMatch(/from\s+"@\/lib\/supabase\//);
  });

  it("the query module re-exports the same values", () => {
    expect(queries.JOB_DESCRIPTIONS_DEFAULT_LIMIT).toBe(JOB_DESCRIPTIONS_DEFAULT_LIMIT);
    expect(queries.JOB_DESCRIPTIONS_MAX_LIMIT).toBe(JOB_DESCRIPTIONS_MAX_LIMIT);
    expect(queries.JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH).toBe(
      JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH,
    );
  });
});
