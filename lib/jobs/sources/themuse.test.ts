import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { computeDedupeKey } from "@/lib/jobs/normalize";
import { SourceHttpError } from "@/lib/jobs/sources/http";
import {
  createThemuseAdapter,
  decodeThemuseCursor,
  mapThemuseJob,
  parseThemuseConfig,
  themuseLocationFromText,
} from "@/lib/jobs/sources/themuse";
import { SourceConfigError, SourceCursorError } from "@/lib/jobs/sources/types";
import {
  JOB_DESCRIPTION_COMPANY_MAX_LENGTH,
  JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_TITLE_MAX_LENGTH,
} from "@/lib/validation/schemas";

const fixture = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/sources/themuse-page.json", import.meta.url), "utf8"),
) as { page_count: number; results: unknown[] };

const signal = new AbortController().signal;

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("mapThemuseJob (fixture)", () => {
  const mapped = fixture.results.map(mapThemuseJob);

  it("maps a full result to NormalizedListing", () => {
    expect(mapped[0]).toEqual({
      externalId: "11000001",
      title: "Data Analyst Intern",
      company: "ExampleCorp, Inc.",
      // v1 stripHtml, kept unchanged: </p> and <li> each add a break, and
      // </ul> adds none (so "Dashboards" runs into "Pay"). Flagged as a
      // follow-up; changing it would rewrite every Muse row's content_hash.
      descriptionText: "Join our analytics team.\n\n- SQL & Python\n- DashboardsPay: $25 /hour",
      sourceUrl: "https://www.themuse.com/jobs/examplecorp/data-analyst-intern",
      applyUrl: null,
      locationText: "New York, NY, Boston, MA",
      primaryLocation: { city: "New York", region: "NY", country: "US" },
      locationCountry: "US",
      remoteType: null,
      employmentType: null,
      levelRaw: "Internship",
      postedAt: "2026-11-10T08:15:00.000Z",
      sourceExpiresAt: null,
      salary: null,
      sourceBoard: null,
      sourceMetadata: { category: "Data and Analytics" },
    });
  });

  it("trims the title, uses only the first level, and marks Flexible / Remote as remote", () => {
    expect(mapped[1]).toMatchObject({
      title: "Junior Software Engineer (Remote)",
      levelRaw: "Entry Level",
      remoteType: "remote",
      primaryLocation: null,
      sourceMetadata: {},
    });
  });

  it("maps 'City, Country' with a known country to ISO", () => {
    expect(mapped[2]).toMatchObject({
      primaryLocation: { city: "London", region: null, country: "GB" },
      locationCountry: "GB",
    });
  });

  it("keeps the link-back obligation visible: a result without landing_page maps to an empty sourceUrl (dropped by the sync)", () => {
    expect(mapped[3]?.sourceUrl).toBe("");
    expect(mapped[3]?.locationText).toBeNull();
  });

  it("maps empty titles and tag-only contents to empty strings (dropped by the sync)", () => {
    expect(mapped[4]?.title).toBe("");
    expect(mapped[4]?.company).toBeNull();
    expect(mapped[5]?.descriptionText).toBe("");
  });

  it("returns null for a result without an id", () => {
    expect(mapped[6]).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(mapThemuseJob(null)).toBeNull();
    expect(mapThemuseJob("x")).toBeNull();
    expect(mapThemuseJob({ id: { nested: true } })).toBeNull();
  });

  it("caps title / company / description to the shared validation limits", () => {
    const m = mapThemuseJob({
      id: 1,
      name: "t".repeat(JOB_DESCRIPTION_TITLE_MAX_LENGTH + 50),
      company: { name: "c".repeat(JOB_DESCRIPTION_COMPANY_MAX_LENGTH + 50) },
      contents: `<p>${"d".repeat(JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH + 50)}</p>`,
      refs: { landing_page: "https://www.themuse.com/jobs/x/y" },
    });
    expect(m?.title).toHaveLength(JOB_DESCRIPTION_TITLE_MAX_LENGTH);
    expect(m?.company).toHaveLength(JOB_DESCRIPTION_COMPANY_MAX_LENGTH);
    expect(m?.descriptionText).toHaveLength(JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH);
  });

  it("drops an unparseable publication_date instead of storing garbage", () => {
    expect(mapThemuseJob({ id: 1, publication_date: "not a date" })?.postedAt).toBeNull();
  });
});

describe("themuseLocationFromText (shared with the key backfill)", () => {
  it.each([
    [null, { remoteType: null, primaryLocation: null, locationCountry: null }],
    ["", { remoteType: null, primaryLocation: null, locationCountry: null }],
    ["Flexible / Remote", { remoteType: "remote", primaryLocation: null, locationCountry: null }],
    ["New York, NY, Flexible / Remote", { remoteType: "remote", primaryLocation: null, locationCountry: null }],
    ["Chicago, IL", { remoteType: null, primaryLocation: { city: "Chicago", region: "IL", country: "US" }, locationCountry: "US" }],
    ["Toronto, Canada", { remoteType: null, primaryLocation: { city: "Toronto", region: null, country: "CA" }, locationCountry: "CA" }],
    ["Lagos, Nigeria", { remoteType: null, primaryLocation: { city: "Lagos", region: null, country: "Nigeria" }, locationCountry: null }],
    ["Paris", { remoteType: null, primaryLocation: { city: "Paris", region: null, country: null }, locationCountry: null }],
  ])("%j", (text, expected) => {
    expect(themuseLocationFromText(text)).toEqual(expected);
  });

  it("gives the adapter and the backfill the same dedupe key for the same stored location", () => {
    const listing = mapThemuseJob(fixture.results[0]);
    if (!listing) throw new Error("fixture");
    const fromAdapter = computeDedupeKey({
      company: listing.company,
      title: listing.title,
      remoteType: listing.remoteType,
      primaryLocation: listing.primaryLocation,
    });
    const stored = themuseLocationFromText(listing.locationText);
    const fromStoredRow = computeDedupeKey({
      company: listing.company,
      title: listing.title,
      remoteType: stored.remoteType,
      primaryLocation: stored.primaryLocation,
    });
    expect(fromStoredRow).toBe(fromAdapter);
  });
});

describe("config and cursor", () => {
  it("applies the seeded defaults to an empty config", () => {
    expect(parseThemuseConfig({})).toEqual({ levels: ["Internship", "Entry Level"], max_pages_per_level: 5 });
    expect(parseThemuseConfig(null)).toEqual({ levels: ["Internship", "Entry Level"], max_pages_per_level: 5 });
  });

  it("rejects an invalid config with SourceConfigError", () => {
    expect(() => parseThemuseConfig({ max_pages_per_level: 0 })).toThrow(SourceConfigError);
    expect(() => parseThemuseConfig({ levels: [] })).toThrow(SourceConfigError);
  });

  it("decodes null as the first page and rejects malformed or out-of-range cursors", () => {
    const cfg = parseThemuseConfig({});
    expect(decodeThemuseCursor(null, cfg)).toEqual({ levelIndex: 0, page: 0 });
    expect(decodeThemuseCursor("1:4", cfg)).toEqual({ levelIndex: 1, page: 4 });
    for (const bad of ["", "1", "a:b", "2:0", "0:5", "0:-1", "0:1:2", " 0:1"]) {
      expect(() => decodeThemuseCursor(bad, cfg), bad).toThrow(SourceCursorError);
    }
  });
});

describe("themuse adapter fetchPage", () => {
  it("requests the newest-first page for the cursor's level and maps the fixture", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fixture));
    const adapter = createThemuseAdapter({ fetchImpl });

    const page = await adapter.fetchPage({ board: null, cursor: "0:1", config: {}, signal });

    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://www.themuse.com/api/public/jobs");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      level: "Internship",
      page: "1",
      sort: "publication_date",
      descending: "true",
    });
    expect(fetchImpl.mock.calls[0][1].headers["User-Agent"]).toMatch(/^Kalify\/2\.0/);
    expect(page.listings).toHaveLength(6);
    // page_count 3: page 1 → page 2 of the same level next.
    expect(page.nextCursor).toBe("0:2");
    expect(page.complete).toBe(false);
  });

  it("moves to the next level after the last page of a level (page_count or max_pages_per_level)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...fixture, page_count: 3 }));
    const adapter = createThemuseAdapter({ fetchImpl });
    expect((await adapter.fetchPage({ board: null, cursor: "0:2", config: {}, signal })).nextCursor).toBe("1:0");

    const capped = createThemuseAdapter({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ ...fixture, page_count: 99 })) });
    expect((await capped.fetchPage({ board: null, cursor: "0:1", config: { max_pages_per_level: 2 }, signal })).nextCursor).toBe("1:0");
  });

  it("reports complete with no next cursor after the last page of the last level", async () => {
    const adapter = createThemuseAdapter({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ ...fixture, page_count: 1 })) });
    const page = await adapter.fetchPage({ board: null, cursor: "1:0", config: {}, signal });
    expect(page.nextCursor).toBeNull();
    expect(page.complete).toBe(true);
  });

  it("treats a missing results array as an empty page", async () => {
    const adapter = createThemuseAdapter({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ page: 0, page_count: 0 })) });
    const page = await adapter.fetchPage({ board: null, cursor: null, config: {}, signal });
    expect(page.listings).toEqual([]);
    expect(page.nextCursor).toBe("1:0");
  });

  it("throws SourceHttpError with status and Retry-After on a 429", async () => {
    const adapter = createThemuseAdapter({
      fetchImpl: vi.fn().mockResolvedValue(new Response("slow down", { status: 429, headers: { "retry-after": "12" } })),
    });
    const err = await adapter.fetchPage({ board: null, cursor: null, config: {}, signal }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceHttpError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(12);
    expect(err.message).not.toContain("slow down");
  });

  it("throws SourceHttpError on an unexpected response shape", async () => {
    const adapter = createThemuseAdapter({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ nope: true })) });
    await expect(adapter.fetchPage({ board: null, cursor: null, config: {}, signal })).rejects.toBeInstanceOf(SourceHttpError);
  });

  it("declares the incremental, no-env, attributed adapter contract", () => {
    const adapter = createThemuseAdapter();
    expect(adapter).toMatchObject({
      slug: "themuse",
      syncMode: "incremental",
      requiredEnv: [],
      attribution: { text: "Listing from The Muse", url: "https://www.themuse.com" },
    });
    expect(adapter.minRequestIntervalMs).toBeGreaterThanOrEqual(1000);
  });
});
