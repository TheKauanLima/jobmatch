import { describe, expect, it } from "vitest";

import { isInvalidInputSyntaxError } from "@/lib/supabase/postgresErrors";

describe("isInvalidInputSyntaxError", () => {
  it("returns true for Postgres code 22P02", () => {
    expect(isInvalidInputSyntaxError({ code: "22P02" })).toBe(true);
  });

  it("returns false for a different Postgres error code", () => {
    expect(isInvalidInputSyntaxError({ code: "23505" })).toBe(false);
  });

  it("returns false for an error with no code", () => {
    expect(isInvalidInputSyntaxError({})).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isInvalidInputSyntaxError(null)).toBe(false);
    expect(isInvalidInputSyntaxError(undefined)).toBe(false);
  });
});
