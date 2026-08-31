import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireSession, mockCreateClient, mockGetMatchById } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
  mockGetMatchById: vi.fn(),
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

vi.mock("@/lib/supabase/queries/matches", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/supabase/queries/matches")
  >("@/lib/supabase/queries/matches");
  return { ...actual, getMatchById: mockGetMatchById };
});

const { GET } = await import("@/app/api/matches/[id]/route");
const { UnauthorizedError } = await import("@/lib/auth/session");

const fakeUser = { id: "user-1" };

const ownedMatchWithJobDescription = {
  id: "match-1",
  resume_id: "resume-1",
  job_description_id: "jd-1",
  user_id: "user-1",
  score: 82,
  rationale: "Good fit.",
  matched_strengths: ["Node.js"],
  gaps: ["Kubernetes"],
  model: "claude-sonnet-5",
  created_at: "t",
  job_description: { id: "jd-1", title: "Backend Engineer", company: "Acme" },
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateClient.mockResolvedValue({});
});

describe("GET /api/matches/:id — privacy boundary", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const res = await GET(new Request("http://x"), ctx("match-1"));
    expect(res.status).toBe(401);
  });

  it("calls getMatchById scoped to the caller's own user id — never trusting the URL alone", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetMatchById.mockResolvedValue(ownedMatchWithJobDescription);

    await GET(new Request("http://x"), ctx("match-1"));

    expect(mockGetMatchById).toHaveBeenCalledWith(expect.anything(), "user-1", "match-1");
  });

  it("returns 404 — not 403, not 200 with someone else's data — when the match belongs to another user", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetMatchById.mockResolvedValue(null);

    const res = await GET(new Request("http://x"), ctx("victim-match-id"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.match).toBeUndefined();
    expect(body.error).not.toMatch(/belongs to|another user/i);
  });

  it("returns the match detail with job_description inlined for the owner", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetMatchById.mockResolvedValue(ownedMatchWithJobDescription);

    const res = await GET(new Request("http://x"), ctx("match-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.match.id).toBe("match-1");
    expect(body.match.score).toBe(82);
    expect(body.match.job_description).toEqual({
      id: "jd-1",
      title: "Backend Engineer",
      company: "Acme",
    });
    expect(body.match).not.toHaveProperty("user_id");
  });

  it("returns 500 (not a crash) when the query layer throws unexpectedly", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetMatchById.mockRejectedValue(new Error("db down"));

    const res = await GET(new Request("http://x"), ctx("match-1"));
    expect(res.status).toBe(500);
  });
});
