import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchLeverBoard,
  mapLeverJob,
  type RawLeverPosting,
} from "@/lib/jobs/sources/lever";
import { JobBoardFetchError } from "@/lib/jobs/sources/common";
import type { JobBoardCompany } from "@/lib/jobs/sources/companies";
import {
  JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_TITLE_MAX_LENGTH,
} from "@/lib/validation/schemas";

/** Real postings from api.lever.co (zoox x2, palantir x1), 2026-11-20. */
const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests/fixtures/sources/lever-board.json"),
    "utf8",
  ),
) as RawLeverPosting[];

const zoox: JobBoardCompany = { provider: "lever", token: "zoox", displayName: "Zoox" };
const palantir: JobBoardCompany = {
  provider: "lever",
  token: "palantir",
  displayName: "Palantir",
};

function fixturePosting(id: string): RawLeverPosting {
  const posting = fixture.find((p) => p.id === id);
  if (!posting) throw new Error(`fixture posting ${id} missing`);
  return posting;
}

function syntheticPosting(overrides: Partial<RawLeverPosting> = {}): RawLeverPosting {
  return {
    id: "abc-123",
    text: "Software Engineering Intern",
    categories: { location: "Austin, TX", allLocations: ["Austin, TX"] },
    country: "US",
    descriptionPlain: "About the role.",
    lists: [
      { text: "What you'll do", content: "<li>Build things</li><li>Ship them</li>" },
    ],
    additionalPlain: "Equal opportunity employer.",
    hostedUrl: "https://jobs.lever.co/acme/abc-123",
    createdAt: 1_794_006_857_184,
    ...overrides,
  };
}

describe("mapLeverJob (recorded fixture)", () => {
  it("maps a US internship with the composed description and createdAt date", () => {
    const raw = fixturePosting("85c6aec7-8da2-445d-9c4d-812365dbce97");
    const row = mapLeverJob(raw, zoox);

    expect(row).toMatchObject({
      externalId: "zoox:85c6aec7-8da2-445d-9c4d-812365dbce97",
      title: "Data Science Intern [Summer 2027]",
      company: "Zoox",
      sourceUrl: raw.hostedUrl,
      level: "Internship",
      // categories.allLocations joined (categories.location is only the first).
      location: "Foster City, CA, Boston, MA",
      postedAt: new Date(raw.createdAt as number).toISOString(),
    });
    expect(row!.description.startsWith((raw.descriptionPlain as string).trim())).toBe(true);
    expect(row!.description).not.toMatch(/<[a-z/][^>]*>/i);
  });

  it("drops a manager title", () => {
    expect(
      mapLeverJob(fixturePosting("222978c8-80d6-4a55-aa40-3bb6eb15671c"), zoox),
    ).toBeNull();
  });

  it("drops a non-US internship (country FR)", () => {
    expect(
      mapLeverJob(fixturePosting("774cf5c9-bf6a-4d77-bf60-d50ef1beb1a0"), palantir),
    ).toBeNull();
  });
});

describe("mapLeverJob (edge cases)", () => {
  it("joins descriptionPlain, list headings + stripped list content, and additionalPlain with blank lines", () => {
    expect(mapLeverJob(syntheticPosting(), zoox)?.description).toBe(
      "About the role.\n\nWhat you'll do\n- Build things\n- Ship them\n\nEqual opportunity employer.",
    );
  });

  it("joins allLocations, falling back to categories.location", () => {
    expect(
      mapLeverJob(
        syntheticPosting({
          categories: { location: "x", allLocations: ["Austin, TX", "Remote"] },
        }),
        zoox,
      )?.location,
    ).toBe("Austin, TX, Remote");
    expect(
      mapLeverJob(
        syntheticPosting({ categories: { location: "Boston, MA" } }),
        zoox,
      )?.location,
    ).toBe("Boston, MA");
  });

  it("lets country decide the US check over the location text", () => {
    expect(
      mapLeverJob(
        syntheticPosting({ country: "CA", categories: { location: "Seattle, WA" } }),
        zoox,
      ),
    ).toBeNull();
    expect(
      mapLeverJob(
        syntheticPosting({ country: "US", categories: { location: "Remote" } }),
        zoox,
      ),
    ).not.toBeNull();
  });

  it("falls back to the location text when country is missing", () => {
    expect(
      mapLeverJob(
        syntheticPosting({ country: undefined, categories: { location: "Toronto, ON" } }),
        zoox,
      ),
    ).toBeNull();
  });

  it("returns null postedAt when createdAt is missing or not a number", () => {
    expect(mapLeverJob(syntheticPosting({ createdAt: undefined }), zoox)?.postedAt).toBeNull();
    expect(mapLeverJob(syntheticPosting({ createdAt: "yesterday" }), zoox)?.postedAt).toBeNull();
  });

  it.each([
    ["no id", { id: undefined }],
    ["no title", { text: "" }],
    ["no description parts", { descriptionPlain: "", lists: [], additionalPlain: null }],
    ["a non-http URL", { hostedUrl: "ftp://jobs.lever.co/x" }],
    ["a senior title", { text: "Senior Software Engineer" }],
  ])("returns null for %s", (_label, overrides) => {
    expect(mapLeverJob(syntheticPosting(overrides as Partial<RawLeverPosting>), zoox)).toBeNull();
  });

  it("clamps title and description", () => {
    const row = mapLeverJob(
      syntheticPosting({
        text: `Intern ${"x".repeat(JOB_DESCRIPTION_TITLE_MAX_LENGTH)}`,
        descriptionPlain: "d".repeat(JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH + 10),
      }),
      zoox,
    );
    expect(row!.title).toHaveLength(JOB_DESCRIPTION_TITLE_MAX_LENGTH);
    expect(row!.description).toHaveLength(JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH);
  });
});

describe("fetchLeverBoard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the postings with mode=json and returns the array", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const postings = await fetchLeverBoard("zoox");

    expect(postings).toHaveLength(fixture.length);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.lever.co/v0/postings/zoox?mode=json",
    );
    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toMatch(/^Kalify\/1\.0/);
  });

  it("throws status 404 for an unknown token, without the body in the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"ok":false,"error":"SECRET-BODY-TEXT"}', { status: 404 }),
      ),
    );
    const err = await fetchLeverBoard("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobBoardFetchError);
    expect((err as JobBoardFetchError).status).toBe(404);
    expect((err as Error).message).toBe('lever board "nope" returned HTTP 404');
    expect((err as Error).message).not.toContain("SECRET-BODY-TEXT");
  });

  it("throws (status null) when the body isn't an array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"postings":[]}', { status: 200 })),
    );
    const err = await fetchLeverBoard("zoox").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobBoardFetchError);
    expect((err as JobBoardFetchError).status).toBeNull();
  });
});

describe("mapLeverJob: ambiguous ', CA' without a country code (QA 2026-11-20)", () => {
  it("drops 'Toronto, ON, CA' text when country is missing", () => {
    expect(
      mapLeverJob(
        syntheticPosting({
          country: undefined,
          categories: { location: "Toronto, ON, CA", allLocations: ["Toronto, ON, CA"] },
        }),
        zoox,
      ),
    ).toBeNull();
  });

  it("keeps 'San Francisco, CA' text when country is missing", () => {
    expect(
      mapLeverJob(
        syntheticPosting({
          country: undefined,
          categories: { location: "San Francisco, CA", allLocations: ["San Francisco, CA"] },
        }),
        zoox,
      ),
    ).not.toBeNull();
  });
});
