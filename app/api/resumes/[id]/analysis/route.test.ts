import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireSession, mockCreateClient, mockGetResumeById, mockGetLatestAnalysis } =
  vi.hoisted(() => ({
    mockRequireSession: vi.fn(),
    mockCreateClient: vi.fn(),
    mockGetResumeById: vi.fn(),
    mockGetLatestAnalysis: vi.fn(),
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

vi.mock("@/lib/supabase/queries/resumes", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/supabase/queries/resumes")
  >("@/lib/supabase/queries/resumes");
  return { ...actual, getResumeById: mockGetResumeById };
});

vi.mock("@/lib/supabase/queries/analyses", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/supabase/queries/analyses")
  >("@/lib/supabase/queries/analyses");
  return { ...actual, getLatestAnalysis: mockGetLatestAnalysis };
});

const { GET } = await import("@/app/api/resumes/[id]/analysis/route");
const { UnauthorizedError } = await import("@/lib/auth/session");

const RESUME_UUID = "11111111-1111-4111-8111-111111111111";
const fakeUser = { id: "user-1" };

const ownedResume = {
  id: RESUME_UUID,
  user_id: "user-1",
  storage_path: "user-1/r1.pdf",
  file_name: "resume.pdf",
  file_type: "application/pdf",
  file_size_bytes: 10,
  extracted_text: "Jane Doe, backend engineer.",
  status: "analyzed",
  created_at: "t",
  updated_at: "t",
};

const analysisRow = {
  id: "analysis-1",
  resume_id: RESUME_UUID,
  user_id: "user-1",
  strengths: [{ label: "Strong backend", detail: "5 years Node.js" }],
  weaknesses: [{ label: "Limited frontend", detail: "No React experience" }],
  summary: "Solid backend engineer.",
  suggested_roles: ["Backend Engineer"],
  model: "claude-sonnet-5",
  created_at: "t",
};

function makeRequest() {
  return new Request(`http://localhost/api/resumes/${RESUME_UUID}/analysis`);
}

function makeContext() {
  return { params: Promise.resolve({ id: RESUME_UUID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateClient.mockResolvedValue({});
});

describe("GET /api/resumes/:id/analysis", () => {
  it("returns 401 when unauthenticated, before touching the DB", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await GET(makeRequest(), makeContext());

    expect(res.status).toBe(401);
    expect(mockGetResumeById).not.toHaveBeenCalled();
  });

  it("returns 404 when the resume doesn't exist or isn't owned by the caller, never leaking existence of another user's analysis", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(null);

    const res = await GET(makeRequest(), makeContext());

    expect(res.status).toBe(404);
    expect(mockGetLatestAnalysis).not.toHaveBeenCalled();
  });

  it("returns 404 (empty state, not an error) when the resume exists but has no analysis yet", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(null);

    const res = await GET(makeRequest(), makeContext());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBeTruthy();
  });

  it("happy path: 200 with the latest analysis for the caller's own resume", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(analysisRow);

    const res = await GET(makeRequest(), makeContext());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.analysis.id).toBe("analysis-1");
    expect(body.analysis.summary).toBe("Solid backend engineer.");
    expect(mockGetLatestAnalysis).toHaveBeenCalledWith(expect.anything(), "user-1", RESUME_UUID);
  });

  it("scopes the resume lookup to the caller's own id, so another user's resume id yields 404 not their analysis", async () => {
    mockRequireSession.mockResolvedValue({ user: { id: "attacker-user" } });
    mockGetResumeById.mockResolvedValue(null);

    const res = await GET(makeRequest(), makeContext());

    expect(res.status).toBe(404);
    expect(mockGetResumeById).toHaveBeenCalledWith(
      expect.anything(),
      "attacker-user",
      RESUME_UUID,
    );
    expect(mockGetLatestAnalysis).not.toHaveBeenCalled();
  });

  it("returns 500 (not a crash) when fetching the resume throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(), makeContext());

    expect(res.status).toBe(500);
  });

  it("returns 500 (not a crash) when fetching the analysis throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(), makeContext());

    expect(res.status).toBe(500);
  });
});
