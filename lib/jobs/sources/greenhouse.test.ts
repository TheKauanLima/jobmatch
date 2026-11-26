import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchGreenhouseBoard,
  mapGreenhouseJob,
  type RawGreenhouseJob,
} from "@/lib/jobs/sources/greenhouse";
import { JobBoardFetchError } from "@/lib/jobs/sources/common";
import type { JobBoardCompany } from "@/lib/jobs/sources/companies";
import {
  JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_LOCATION_MAX_LENGTH,
  JOB_DESCRIPTION_TITLE_MAX_LENGTH,
} from "@/lib/validation/schemas";

/** Real list response from boards-api.greenhouse.io (figma), trimmed to 4 jobs, 2026-11-20. */
const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests/fixtures/sources/greenhouse-board.json"),
    "utf8",
  ),
) as { jobs: RawGreenhouseJob[] };

const figma: JobBoardCompany = {
  provider: "greenhouse",
  token: "figma",
  displayName: "Figma",
};

function fixtureJob(id: number): RawGreenhouseJob {
  const job = fixture.jobs.find((j) => j.id === id);
  if (!job) throw new Error(`fixture job ${id} missing`);
  return job;
}

function syntheticJob(overrides: Partial<RawGreenhouseJob> = {}): RawGreenhouseJob {
  return {
    id: 123,
    title: "Software Engineer Intern",
    location: { name: "New York, NY" },
    absolute_url: "https://job-boards.greenhouse.io/acme/jobs/123",
    content: "&lt;p&gt;Build &amp;amp; ship.&lt;/p&gt;",
    first_published: "2026-11-01T09:00:00-05:00",
    ...overrides,
  };
}

describe("mapGreenhouseJob (recorded fixture)", () => {
  it("maps a US internship: prefixed externalId, displayName company, decoded plain-text description", () => {
    const raw = fixtureJob(6178851004);
    const row = mapGreenhouseJob(raw, figma);

    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      externalId: "figma:6178851004",
      title: "Data Engineer Intern (2027)",
      company: "Figma",
      sourceUrl: raw.absolute_url,
      level: "Internship",
      location: "San Francisco, CA • New York, NY",
      postedAt: new Date(raw.first_published as string).toISOString(),
    });
    // Escaped markup was decoded and stripped: no tags or entities left.
    expect(row!.description).not.toMatch(/<[a-z/][^>]*>/i);
    expect(row!.description).not.toMatch(/&(lt|gt|amp|quot|nbsp);/);
    expect(row!.description.length).toBeGreaterThan(100);
  });

  it("drops a title that only looks like 'intern' inside a word (Internal Tools)", () => {
    expect(mapGreenhouseJob(fixtureJob(6233043004), figma)).toBeNull();
  });

  it("drops a senior title", () => {
    expect(mapGreenhouseJob(fixtureJob(6239959004), figma)).toBeNull();
  });

  it("drops a non-US internship (London)", () => {
    expect(mapGreenhouseJob(fixtureJob(6152695004), figma)).toBeNull();
  });
});

describe("mapGreenhouseJob (edge cases)", () => {
  it("decodes then strips the content", () => {
    expect(mapGreenhouseJob(syntheticJob(), figma)?.description).toBe(
      "Build & ship.",
    );
  });

  it("uses first_published for postedAt and never updated_at", () => {
    const withUpdated = {
      ...syntheticJob({ first_published: undefined }),
      updated_at: "2026-11-19T00:00:00Z",
    } as RawGreenhouseJob;
    expect(mapGreenhouseJob(withUpdated, figma)?.postedAt).toBeNull();
    expect(mapGreenhouseJob(syntheticJob(), figma)?.postedAt).toBe(
      "2026-11-01T14:00:00.000Z",
    );
  });

  it("returns null postedAt for an unparseable first_published", () => {
    expect(
      mapGreenhouseJob(syntheticJob({ first_published: "not a date" }), figma)
        ?.postedAt,
    ).toBeNull();
  });

  it.each([
    ["no id", { id: undefined }],
    ["no title", { title: "  " }],
    ["no content", { content: undefined }],
    ["content that strips to nothing", { content: "&lt;p&gt;&lt;/p&gt;" }],
    ["a non-http URL", { absolute_url: "javascript:alert(1)" }],
    ["a relative URL", { absolute_url: "/jobs/123" }],
    ["no URL", { absolute_url: null }],
  ])("returns null for %s", (_label, overrides) => {
    expect(
      mapGreenhouseJob(syntheticJob(overrides as Partial<RawGreenhouseJob>), figma),
    ).toBeNull();
  });

  describe("offices[] as an additional US signal", () => {
    it("keeps a job whose location.name has no US signal when an office location is in the US", () => {
      const row = mapGreenhouseJob(
        syntheticJob({
          location: { name: "Hybrid" },
          offices: [
            { name: "Los Angeles", location: "Los Angeles, California, United States" },
          ],
        }),
        figma,
      );
      expect(row).not.toBeNull();
      // The stored location is still location.name.
      expect(row!.location).toBe("Hybrid");
    });

    it("keeps a job when an office name carries the US signal (', CA')", () => {
      expect(
        mapGreenhouseJob(
          syntheticJob({
            location: { name: "San Francisco Bay Area" },
            offices: [{ name: "San Francisco, CA", location: null }],
          }),
          figma,
        ),
      ).not.toBeNull();
    });

    it("keeps a job when any one of several offices is in the US", () => {
      expect(
        mapGreenhouseJob(
          syntheticJob({
            location: { name: "In-Office" },
            offices: [
              { name: "London", location: "London, England, United Kingdom" },
              { name: "Austin", location: "Austin, Texas, United States" },
            ],
          }),
          figma,
        ),
      ).not.toBeNull();
    });

    // Real shapes from the 2026-11-20 dry run: Greenhouse attaches several
    // company offices to one posting, so an explicit non-US location.name
    // wins over any US office.
    it.each([
      [
        "brex: Vancouver, British Columbia, Canada",
        "Vancouver, British Columbia, Canada",
        [
          { name: "New York", location: "New York, New York, United States" },
          { name: "Vancouver", location: "Vancouver, British Columbia, Canada" },
        ],
      ],
      [
        "brex: São Paulo, Brazil",
        "São Paulo, São Paulo, Brazil",
        [{ name: "Seattle", location: "Seattle, Washington, United States" }],
      ],
      [
        "mongodb: Toronto",
        "Toronto",
        [{ name: "New York", location: "New York, NY, United States" }],
      ],
      [
        "affirm: Remote Canada",
        "Remote Canada",
        [
          { name: "Remote Canada", location: null },
          { name: "Remote US", location: null },
        ],
      ],
    ])(
      "drops %s even with a US office attached",
      (_label, locationName, offices) => {
        expect(
          mapGreenhouseJob(
            syntheticJob({ location: { name: locationName }, offices }),
            figma,
          ),
        ).toBeNull();
      },
    );

    it("consults offices for a bare US city name with no state (placeless)", () => {
      expect(
        mapGreenhouseJob(
          syntheticJob({
            location: { name: "Austin" },
            offices: [{ name: "Austin", location: "Austin, TX, United States" }],
          }),
          figma,
        ),
      ).not.toBeNull();
    });

    it("drops a job when location.name and every office are non-US", () => {
      expect(
        mapGreenhouseJob(
          syntheticJob({
            location: { name: "Hybrid" },
            offices: [{ name: "Toronto", location: "Toronto, Ontario, Canada" }],
          }),
          figma,
        ),
      ).toBeNull();
    });

    it("does not let blank or Remote-only office values rescue a non-US location", () => {
      expect(
        mapGreenhouseJob(
          syntheticJob({
            location: { name: "Hybrid" },
            offices: [
              { name: "Remote", location: "" },
              { name: null, location: null },
              null,
              "Remote",
            ],
          }),
          figma,
        ),
      ).toBeNull();
    });

    it("drops a job with a non-US location.name and no offices", () => {
      expect(
        mapGreenhouseJob(syntheticJob({ location: { name: "Hybrid" } }), figma),
      ).toBeNull();
      expect(
        mapGreenhouseJob(
          syntheticJob({ location: { name: "Hybrid" }, offices: "nope" }),
          figma,
        ),
      ).toBeNull();
    });
  });

  it("keeps a listing with no location (treated like remote/unspecified)", () => {
    expect(
      mapGreenhouseJob(syntheticJob({ location: null }), figma)?.location,
    ).toBeNull();
  });

  it("clamps title, location and description to the shared max lengths", () => {
    const row = mapGreenhouseJob(
      syntheticJob({
        title: `Intern ${"x".repeat(JOB_DESCRIPTION_TITLE_MAX_LENGTH)}`,
        location: { name: `Boston, MA ${"y".repeat(500)}` },
        content: "z".repeat(JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH + 50),
      }),
      figma,
    );
    expect(row!.title).toHaveLength(JOB_DESCRIPTION_TITLE_MAX_LENGTH);
    expect(row!.location).toHaveLength(JOB_DESCRIPTION_LOCATION_MAX_LENGTH);
    expect(row!.description).toHaveLength(JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH);
  });

  it("stringifies numeric ids into the token-prefixed externalId", () => {
    expect(mapGreenhouseJob(syntheticJob({ id: 987 }), figma)?.externalId).toBe(
      "figma:987",
    );
  });
});

describe("fetchGreenhouseBoard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("GETs the board with content=true and the Kalify User-Agent, returning jobs", async () => {
    vi.stubEnv("APP_BASE_URL", "https://kalify.example");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await fetchGreenhouseBoard("figma");

    expect(jobs).toHaveLength(fixture.jobs.length);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://boards-api.greenhouse.io/v1/boards/figma/jobs?content=true",
    );
    expect(init.headers["User-Agent"]).toBe("Kalify/1.0 (+https://kalify.example)");
  });

  it("uses a bare Kalify/1.0 User-Agent when APP_BASE_URL is unset", async () => {
    vi.stubEnv("APP_BASE_URL", "");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ jobs: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchGreenhouseBoard("figma");

    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toBe("Kalify/1.0");
  });

  it("throws a JobBoardFetchError with status 404 for an unknown token, without the body or URL in the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"status":404,"error":"SECRET-BODY-TEXT"}', { status: 404 }),
      ),
    );

    const err = await fetchGreenhouseBoard("nope").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JobBoardFetchError);
    expect((err as JobBoardFetchError).status).toBe(404);
    expect((err as Error).message).toBe('greenhouse board "nope" returned HTTP 404');
    expect((err as Error).message).not.toContain("SECRET-BODY-TEXT");
    expect((err as Error).message).not.toContain("boards-api");
  });

  it("throws (status null) when the body has no jobs array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"oops":true}', { status: 200 })),
    );
    const err = await fetchGreenhouseBoard("figma").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobBoardFetchError);
    expect((err as JobBoardFetchError).status).toBeNull();
  });

  it("throws (status null) when the body isn't JSON, without echoing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>Just a moment...</html>", { status: 200 }),
      ),
    );
    const err = await fetchGreenhouseBoard("figma").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobBoardFetchError);
    expect((err as Error).message).not.toContain("Just a moment");
  });

  it("reports a network failure without the underlying error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("getaddrinfo ENOTFOUND boards-api.greenhouse.io")),
    );
    const err = await fetchGreenhouseBoard("figma").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobBoardFetchError);
    expect((err as Error).message).toBe('greenhouse board "figma" network error');
  });

  it("reports an aborted/timed-out request as a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError")),
    );
    const err = await fetchGreenhouseBoard("figma", AbortSignal.timeout(1)).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('greenhouse board "figma" timed out');
  });
});

describe("mapGreenhouseJob: ambiguous ', CA' country code (QA, live bug 2026-11-20)", () => {
  // Real shape: pinterest "Machine Learning Intern 2027 (Toronto)" was kept
  // because the trailing ", CA" (Canada) was read as California.
  it("drops 'Toronto, ON, CA' even with a US office attached", () => {
    expect(
      mapGreenhouseJob(
        syntheticJob({
          title: "Machine Learning Intern 2027 (Toronto)",
          location: { name: "Toronto, ON, CA" },
          offices: [
            { name: "San Francisco, CA, US", location: "San Francisco, California, United States" },
          ],
        }),
        figma,
      ),
    ).toBeNull();
  });

  it("does not let a Canadian 'City, ON, CA' office rescue a placeless location", () => {
    expect(
      mapGreenhouseJob(
        syntheticJob({
          location: { name: "Hybrid" },
          offices: [{ name: "Toronto, ON, CA", location: null }],
        }),
        figma,
      ),
    ).toBeNull();
  });

  it.each(["San Francisco, CA, US", "San Francisco, CA, US; Remote, CA, US", "Los Angeles, CA"])(
    "keeps California location %j",
    (name) => {
      expect(
        mapGreenhouseJob(syntheticJob({ location: { name } }), figma),
      ).not.toBeNull();
    },
  );
});
