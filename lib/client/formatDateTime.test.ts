import { describe, expect, it } from "vitest";

import { formatLocalDateTime } from "@/lib/client/formatDateTime";

describe("formatLocalDateTime", () => {
  it("formats in the given time zone and names the zone", () => {
    expect(
      formatLocalDateTime("2026-11-13T00:00:00.000Z", {
        locale: "en-US",
        timeZone: "America/New_York",
      }),
    ).toBe("Nov 12, 2026, 7:00 PM EST");
  });

  it("formats UTC as UTC", () => {
    expect(
      formatLocalDateTime("2026-11-13T00:00:00Z", {
        locale: "en-US",
        timeZone: "UTC",
      }),
    ).toBe("Nov 13, 2026, 12:00 AM UTC");
  });

  it("returns null for missing or unparseable input", () => {
    expect(formatLocalDateTime(null)).toBeNull();
    expect(formatLocalDateTime(undefined)).toBeNull();
    expect(formatLocalDateTime("")).toBeNull();
    expect(formatLocalDateTime("not a date")).toBeNull();
  });
});
