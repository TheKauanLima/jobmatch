import { describe, expect, it } from "vitest";

import { jobDescriptionListQuerySchema } from "@/lib/validation/schemas";

/** QA: GET /api/job-descriptions query validation (§7.8.6). */
function parse(params: Record<string, string>) {
  return jobDescriptionListQuerySchema.safeParse(params);
}

describe("jobDescriptionListQuerySchema", () => {
  it("defaults: no q → sort recent, nulls, limit 20", () => {
    const result = parse({});
    expect(result.success && result.data).toEqual({
      q: null,
      level: null,
      category: null,
      location: null,
      sort: "recent",
      limit: 20,
      cursor: null,
    });
  });

  it("defaults sort to relevance with q", () => {
    const result = parse({ q: "  data  " });
    expect(result.success && result.data).toMatchObject({ q: "data", sort: "relevance" });
  });

  it("rejects sort=relevance without q (and with whitespace-only q)", () => {
    expect(parse({ sort: "relevance" }).success).toBe(false);
    expect(parse({ sort: "relevance", q: "   " }).success).toBe(false);
  });

  it("accepts sort=recent without q", () => {
    expect(parse({ sort: "recent" }).success).toBe(true);
  });

  it("rejects an unknown sort", () => {
    expect(parse({ sort: "oldest", q: "x" }).success).toBe(false);
  });

  it("rejects an unknown category and a wrong-case category", () => {
    expect(parse({ category: "astrology" }).success).toBe(false);
    expect(parse({ category: "Software" }).success).toBe(false);
  });

  it.each(["software", "it-security", "other"])("accepts category %s", (category) => {
    const result = parse({ category });
    expect(result.success && result.data.category).toBe(category);
  });

  it.each([
    ["ca", "CA"],
    ["Ca", "CA"],
    [" ny ", "NY"],
    ["dc", "DC"],
    ["REMOTE", "remote"],
    ["Remote", "remote"],
  ])("normalizes location %j → %j", (location, expected) => {
    const result = parse({ location });
    expect(result.success && result.data.location).toBe(expected);
  });

  it.each(["XX", "PR", "US", "California", "remote,CA", "ON"])(
    "rejects unknown location %j",
    (location) => {
      expect(parse({ location }).success).toBe(false);
    },
  );

  it("treats empty-string params as absent", () => {
    const result = parse({ q: "", level: "", category: "", location: "", sort: "", limit: "", cursor: "" });
    expect(result.success && result.data).toMatchObject({
      q: null,
      level: null,
      category: null,
      location: null,
      sort: "recent",
      limit: 20,
      cursor: null,
    });
  });

  it("ignores unknown params", () => {
    expect(parse({ foo: "bar", job_category: "data" }).success).toBe(true);
  });

  it("caps limit at 100 and rejects non-integers", () => {
    const capped = parse({ limit: "500" });
    expect(capped.success && capped.data.limit).toBe(100);
    expect(parse({ limit: "abc" }).success).toBe(false);
    expect(parse({ limit: "0" }).success).toBe(false);
    expect(parse({ limit: "1.5" }).success).toBe(false);
  });

  it("rejects an unknown level", () => {
    expect(parse({ level: "Senior" }).success).toBe(false);
  });

  it("combines every filter with q", () => {
    const result = parse({ q: "ml", level: "Internship", category: "data", location: "wa", sort: "recent" });
    expect(result.success && result.data).toMatchObject({
      q: "ml",
      level: "Internship",
      category: "data",
      location: "WA",
      sort: "recent",
    });
  });
});
