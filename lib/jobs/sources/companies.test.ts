import { describe, expect, it } from "vitest";

import {
  JOB_BOARD_COMPANIES,
  MAX_COMPANIES_PER_RUN,
} from "@/lib/jobs/sources/companies";

describe("JOB_BOARD_COMPANIES", () => {
  it("is non-empty and within MAX_COMPANIES_PER_RUN (40)", () => {
    expect(MAX_COMPANIES_PER_RUN).toBe(40);
    expect(JOB_BOARD_COMPANIES.length).toBeGreaterThan(0);
    expect(JOB_BOARD_COMPANIES.length).toBeLessThanOrEqual(
      MAX_COMPANIES_PER_RUN,
    );
  });

  it.each(JOB_BOARD_COMPANIES.map((c) => [`${c.provider}:${c.token}`, c]))(
    "%s has a safe token, a known provider, and a display name",
    (_label, company) => {
      expect(company.token).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(["greenhouse", "lever"]).toContain(company.provider);
      expect(company.displayName.trim()).not.toBe("");
    },
  );

  it("has no duplicate (provider, token) pairs", () => {
    const keys = JOB_BOARD_COMPANIES.map((c) => `${c.provider}:${c.token}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
