import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireSession, mockCreateClient, mockGetJobDescriptionById } =
  vi.hoisted(() => ({
    mockRequireSession: vi.fn(),
    mockCreateClient: vi.fn(),
    mockGetJobDescriptionById: vi.fn(),
  }));

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>(
    "@/lib/auth/session",
  );
  return { ...actual, requireSession: mockRequireSession };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateClient,
}));

vi.mock("@/lib/supabase/queries/jobDescriptions", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/supabase/queries/jobDescriptions")
  >("@/lib/supabase/queries/jobDescriptions");
  return {
    ...actual,
    getJobDescriptionById: mockGetJobDescriptionById,
  };
});

const { GET } = await import("@/app/api/job-descriptions/[id]/route");
const { UnauthorizedError } = await import("@/lib/auth/session");

const fakeUser = { id: "user-1" };
const otherUsersRow = {
  id: "jd-1",
  submitted_by: "someone-else",
  title: "Software Engineer",
  company: "Acme",
  description: "Build things.",
  source_url: null,
  created_at: "t",
  updated_at: "t",
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateClient.mockResolvedValue({});
});

describe("GET /api/job-descriptions/:id — shared data, no ownership check", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const res = await GET(new Request("http://x"), ctx("jd-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the row doesn't exist", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(null);

    const res = await GET(new Request("http://x"), ctx("missing-id"));
    expect(res.status).toBe(404);
  });

  it("returns a job description submitted by a DIFFERENT user — no ownership gate for reads (shared data)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(otherUsersRow);

    const res = await GET(new Request("http://x"), ctx("jd-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.job_description.id).toBe("jd-1");
    expect(body.job_description).not.toHaveProperty("submitted_by");
  });

  it("returns 500 (not a crash) when the query layer throws unexpectedly", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockRejectedValue(new Error("db down"));

    const res = await GET(new Request("http://x"), ctx("jd-1"));
    expect(res.status).toBe(500);
  });
});
