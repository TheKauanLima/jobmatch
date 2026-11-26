import { describe, expect, it } from "vitest";

import { mapGreenhouseJob, type RawGreenhouseJob } from "@/lib/jobs/sources/greenhouse";
import { mapLeverJob, type RawLeverPosting } from "@/lib/jobs/sources/lever";
import type { JobBoardCompany } from "@/lib/jobs/sources/companies";

/**
 * QA (§7.8.4): the board facets the source mappers attach — department/team
 * feed the classifier, Lever `workplaceType === "remote"` is a remote hint,
 * and malformed department payloads never crash the mapper.
 */

const acmeGh: JobBoardCompany = { provider: "greenhouse", token: "acme", displayName: "Acme" };
const acmeLever: JobBoardCompany = { provider: "lever", token: "acme", displayName: "Acme" };

function ghJob(overrides: Partial<RawGreenhouseJob> = {}): RawGreenhouseJob {
  return {
    id: 1,
    title: "Summer Intern",
    location: { name: "New York, NY" },
    absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1",
    content: "&lt;p&gt;Do things.&lt;/p&gt;",
    first_published: "2026-11-01T09:00:00-05:00",
    ...overrides,
  };
}

function leverPosting(overrides: Partial<RawLeverPosting> = {}): RawLeverPosting {
  return {
    id: "abc-123",
    text: "Summer Intern",
    categories: { location: "Austin, TX", allLocations: ["Austin, TX"] },
    country: "US",
    descriptionPlain: "About the role.",
    hostedUrl: "https://jobs.lever.co/acme/abc-123",
    createdAt: 1_794_006_857_184,
    ...overrides,
  };
}

describe("mapGreenhouseJob facets", () => {
  it("uses departments[].name for a vague title", () => {
    const row = mapGreenhouseJob(ghJob({ departments: [{ name: "Finance" }] }), acmeGh);
    expect(row).toMatchObject({ jobCategory: "finance", locationStates: ["NY"], isRemote: false });
  });

  it("falls back to other without a department", () => {
    expect(mapGreenhouseJob(ghJob(), acmeGh)?.jobCategory).toBe("other");
  });

  it.each([
    ["not an array", "Finance"],
    ["null entries", [null, 42, { name: 7 }, { nope: "x" }]],
    ["blank names", [{ name: "   " }]],
  ])("ignores a malformed departments payload (%s)", (_label, departments) => {
    const row = mapGreenhouseJob(ghJob({ departments }), acmeGh);
    expect(row?.jobCategory).toBe("other");
  });

  it("derives remote from the location name", () => {
    const row = mapGreenhouseJob(ghJob({ location: { name: "Remote - USA" } }), acmeGh);
    expect(row).toMatchObject({ locationStates: [], isRemote: true });
  });
});

describe("mapLeverJob facets", () => {
  it("uses categories.department + team for a vague title", () => {
    const row = mapLeverJob(
      leverPosting({
        categories: { location: "Austin, TX", department: "Zoox Internships", team: "Software" },
      }),
      acmeLever,
    );
    expect(row).toMatchObject({ jobCategory: "software", locationStates: ["TX"] });
  });

  it("treats workplaceType 'remote' as a remote hint, keeping the states", () => {
    const row = mapLeverJob(leverPosting({ workplaceType: "remote" }), acmeLever);
    expect(row).toMatchObject({ locationStates: ["TX"], isRemote: true });
  });

  it.each(["hybrid", "onsite", "unspecified", "REMOTE", 1, null])(
    "does not treat workplaceType %j as remote",
    (workplaceType) => {
      const row = mapLeverJob(leverPosting({ workplaceType }), acmeLever);
      expect(row?.isRemote).toBe(false);
    },
  );

  it("ignores non-string department/team values", () => {
    const row = mapLeverJob(
      leverPosting({ categories: { location: "Austin, TX", department: 5, team: { x: 1 } } }),
      acmeLever,
    );
    expect(row?.jobCategory).toBe("other");
  });
});
