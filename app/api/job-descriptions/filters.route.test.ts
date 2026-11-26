import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QA (§7.8.6 / §7.8.4): board filters through GET /api/job-descriptions,
 * and the guarantee that neither POST nor PATCH lets the body set
 * job_category / location_states / is_remote.
 */
const {
  mockRequireSession,
  mockCreateClient,
  mockListJobDescriptions,
  mockSearchJobDescriptions,
  mockCreateJobDescription,
  mockGetJobDescriptionById,
  mockUpdateJobDescription,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
  mockListJobDescriptions: vi.fn(),
  mockSearchJobDescriptions: vi.fn(),
  mockCreateJobDescription: vi.fn(),
  mockGetJobDescriptionById: vi.fn(),
  mockUpdateJobDescription: vi.fn(),
}));

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return { ...actual, requireSession: mockRequireSession };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: mockCreateClient }));
vi.mock("@/lib/supabase/queries/jobDescriptions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase/queries/jobDescriptions")>(
    "@/lib/supabase/queries/jobDescriptions",
  );
  return {
    ...actual,
    listJobDescriptions: mockListJobDescriptions,
    searchJobDescriptions: mockSearchJobDescriptions,
    createJobDescription: mockCreateJobDescription,
    getJobDescriptionById: mockGetJobDescriptionById,
    updateJobDescription: mockUpdateJobDescription,
  };
});

const { GET, POST } = await import("@/app/api/job-descriptions/route");
const { PATCH } = await import("@/app/api/job-descriptions/[id]/route");

const user = { id: "user-1" };
const row = {
  id: "jd-1",
  submitted_by: "user-1",
  title: "Software Engineer",
  company: null,
  description: "Build.",
  source_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  source: "user",
  external_id: null,
  level: null,
  location: "Austin, TX",
  posted_at: null,
  deleted_at: null,
  job_category: "software",
  location_states: ["TX"],
  is_remote: false,
  listed_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateClient.mockResolvedValue({});
  mockRequireSession.mockResolvedValue({ user });
  mockListJobDescriptions.mockResolvedValue({ items: [], hasMore: false });
  mockSearchJobDescriptions.mockResolvedValue({ items: [], hasMore: false });
});

const get = (qs: string) => GET(new Request(`http://localhost/api/job-descriptions${qs}`));

describe("GET /api/job-descriptions filters", () => {
  it("passes category + case-insensitive location to the list query", async () => {
    const res = await get("?category=data&location=ca");
    expect(res.status).toBe(200);
    expect(mockListJobDescriptions).toHaveBeenCalledWith(expect.anything(), {
      limit: 20,
      cursor: null,
      level: null,
      category: "data",
      location: "CA",
    });
  });

  it("passes location=Remote as 'remote'", async () => {
    await get("?location=Remote");
    expect(mockListJobDescriptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ location: "remote" }),
    );
  });

  it("combines q with level/category/location/sort in search mode", async () => {
    await get("?q=ml&level=Internship&category=data&location=WA&sort=recent");
    expect(mockSearchJobDescriptions).toHaveBeenCalledWith(expect.anything(), {
      query: "ml",
      limit: 20,
      offset: 0,
      sort: "recent",
      level: "Internship",
      category: "data",
      location: "WA",
    });
    expect(mockListJobDescriptions).not.toHaveBeenCalled();
  });

  it.each([
    ["?sort=relevance", /relevance/],
    ["?category=astrology", /category/],
    ["?location=Ontario", /location/],
    ["?location=PR", /location/],
    ["?sort=newest&q=x", /sort/],
  ])("returns 400 for %s without querying", async (qs, message) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(mockListJobDescriptions).not.toHaveBeenCalled();
    expect(mockSearchJobDescriptions).not.toHaveBeenCalled();
  });

  it("validates params only after auth (401 beats 400 when signed out)", async () => {
    const { UnauthorizedError } = await import("@/lib/auth/session");
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const res = await get("?category=astrology");
    expect(res.status).toBe(401);
  });

  it("exposes job_category but not location_states / is_remote / listed_at", async () => {
    mockListJobDescriptions.mockResolvedValue({ items: [row], hasMore: false });
    const body = await (await get("")).json();
    expect(body.job_descriptions[0].job_category).toBe("software");
    expect(body.job_descriptions[0]).not.toHaveProperty("location_states");
    expect(body.job_descriptions[0]).not.toHaveProperty("is_remote");
    expect(body.job_descriptions[0]).not.toHaveProperty("listed_at");
  });
});

describe("POST /api/job-descriptions facets are server-derived", () => {
  it("ignores job_category / location_states / is_remote in the body", async () => {
    mockCreateJobDescription.mockResolvedValue(row);
    const res = await POST(
      new Request("http://localhost/api/job-descriptions", {
        method: "POST",
        body: JSON.stringify({
          title: "Data Scientist Intern",
          description: "Analyze.",
          location: "Seattle, WA",
          job_category: "legal",
          jobCategory: "legal",
          location_states: ["HI"],
          locationStates: ["HI"],
          is_remote: true,
          isRemote: true,
        }),
      }),
    );
    expect(res.status).toBe(201);
    expect(mockCreateJobDescription).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jobCategory: "data",
        locationStates: ["WA"],
        isRemote: false,
      }),
    );
  });
});

describe("PATCH /api/job-descriptions/:id facet recompute", () => {
  const patch = (body: unknown) =>
    PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: "jd-1" }),
    });

  beforeEach(() => {
    mockGetJobDescriptionById.mockResolvedValue(row);
    mockUpdateJobDescription.mockResolvedValue(row);
  });

  it("a body with only facet fields is rejected or a no-op, never written", async () => {
    const res = await patch({ job_category: "legal", location_states: ["HI"], is_remote: true });
    if (res.status === 200) {
      const patchArg = mockUpdateJobDescription.mock.calls[0][1].patch;
      expect(patchArg.jobCategory).toBeUndefined();
      expect(patchArg.locationStates).toBeUndefined();
      expect(patchArg.isRemote).toBeUndefined();
    } else {
      expect(res.status).toBe(400);
      expect(mockUpdateJobDescription).not.toHaveBeenCalled();
    }
  });

  it("recomputes from the new title + existing location, ignoring body facet fields", async () => {
    await patch({ title: "Recruiting Coordinator", job_category: "software", is_remote: true });
    expect(mockUpdateJobDescription.mock.calls[0][1].patch).toMatchObject({
      title: "Recruiting Coordinator",
      jobCategory: "people-hr",
      locationStates: ["TX"],
      isRemote: false,
    });
  });

  it("recomputes from the existing title + new location", async () => {
    await patch({ location: "Remote - ME" });
    expect(mockUpdateJobDescription.mock.calls[0][1].patch).toMatchObject({
      jobCategory: "software",
      locationStates: ["ME"],
      isRemote: true,
    });
  });

  it("clearing the location clears the location facets", async () => {
    await patch({ location: "" });
    expect(mockUpdateJobDescription.mock.calls[0][1].patch).toMatchObject({
      location: null,
      locationStates: [],
      isRemote: false,
    });
  });

  it("does not touch facets when neither title nor location changes", async () => {
    await patch({ company: "Acme" });
    const patchArg = mockUpdateJobDescription.mock.calls[0][1].patch;
    expect(patchArg.jobCategory).toBeUndefined();
    expect(patchArg.locationStates).toBeUndefined();
    expect(patchArg.isRemote).toBeUndefined();
  });
});
