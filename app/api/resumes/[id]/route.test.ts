import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireSession,
  mockCreateClient,
  mockGetResumeById,
  mockDeleteResume,
  mockDeleteResumeFile,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
  mockGetResumeById: vi.fn(),
  mockDeleteResume: vi.fn(),
  mockDeleteResumeFile: vi.fn(),
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
  return {
    ...actual,
    getResumeById: mockGetResumeById,
    deleteResume: mockDeleteResume,
  };
});

vi.mock("@/lib/storage/resumeFiles", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/storage/resumeFiles")
  >("@/lib/storage/resumeFiles");
  return { ...actual, deleteResumeFile: mockDeleteResumeFile };
});

const { GET, DELETE } = await import("@/app/api/resumes/[id]/route");
const { UnauthorizedError } = await import("@/lib/auth/session");

const fakeUser = { id: "user-1" };
const ownedResume = {
  id: "r1",
  user_id: "user-1",
  storage_path: "user-1/r1.pdf",
  file_name: "resume.pdf",
  file_type: "application/pdf",
  file_size_bytes: 10,
  extracted_text: "confidential content",
  status: "uploaded",
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

describe("GET /api/resumes/:id — privacy boundary", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const res = await GET(new Request("http://x"), ctx("r1"));
    expect(res.status).toBe(401);
  });

  it("calls getResumeById scoped to the caller's own user id — never trusting the URL alone", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);

    await GET(new Request("http://x"), ctx("r1"));

    expect(mockGetResumeById).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "r1",
    );
  });

  it("returns 404 — not 403, not 200 with someone else's data — when the resume belongs to another user", async () => {
    // Simulates the query layer correctly scoping by user_id and finding
    // nothing, exactly as it would for another user's resume id.
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(null);

    const res = await GET(new Request("http://x"), ctx("victim-resume-id"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.resume).toBeUndefined();
    // Error message must not leak whether the row exists for someone else.
    expect(body.error).not.toMatch(/belongs to|another user/i);
  });

  it("returns full detail including extracted_text for the owner", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);

    const res = await GET(new Request("http://x"), ctx("r1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.resume.extracted_text).toBe("confidential content");
    expect(body.resume).not.toHaveProperty("storage_path");
    expect(body.resume).not.toHaveProperty("user_id");
  });

  it("returns 500 (not a crash) when the query layer throws unexpectedly", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockRejectedValue(new Error("db down"));

    const res = await GET(new Request("http://x"), ctx("r1"));
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/resumes/:id — privacy boundary + ordering", () => {
  it("returns 404 for another user's resume id and never calls Storage delete or DB delete", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(null);

    const res = await DELETE(new Request("http://x"), ctx("victim-resume-id"));

    expect(res.status).toBe(404);
    expect(mockDeleteResumeFile).not.toHaveBeenCalled();
    expect(mockDeleteResume).not.toHaveBeenCalled();
  });

  it("deletes the Storage object before the DB row (ownership-checked resume)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockDeleteResumeFile.mockResolvedValue(undefined);
    mockDeleteResume.mockResolvedValue(undefined);

    const callOrder: string[] = [];
    mockDeleteResumeFile.mockImplementation(async () => {
      callOrder.push("storage");
    });
    mockDeleteResume.mockImplementation(async () => {
      callOrder.push("db");
    });

    const res = await DELETE(new Request("http://x"), ctx("r1"));

    expect(res.status).toBe(204);
    expect(callOrder).toEqual(["storage", "db"]);
    expect(mockDeleteResumeFile).toHaveBeenCalledWith(
      expect.anything(),
      "user-1/r1.pdf",
    );
    expect(mockDeleteResume).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "r1",
    );
  });

  it("if Storage delete fails, the DB row is left intact (deleteResume is never called) so the delete can be retried", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockDeleteResumeFile.mockRejectedValue(new Error("storage unavailable"));

    const res = await DELETE(new Request("http://x"), ctx("r1"));

    expect(res.status).toBe(500);
    expect(mockDeleteResume).not.toHaveBeenCalled();
  });

  it("BUG-CANDIDATE: if Storage delete succeeds but the DB delete then fails, the row survives with a missing file and the route still reports a generic 500 with no state signal for the client to distinguish 'fully failed, retry from scratch' from 'file gone, row stuck'", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockDeleteResumeFile.mockResolvedValue(undefined);
    mockDeleteResume.mockRejectedValue(new Error("db connection dropped"));

    const res = await DELETE(new Request("http://x"), ctx("r1"));
    const body = await res.json();

    // Current behavior: generic 500, identical to "everything failed".
    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to delete resume.");
    // The Storage object IS gone at this point even though the client sees
    // the same error shape as a total failure — documented via this test so
    // a retry-idempotency change is caught if it regresses further.
    expect(mockDeleteResumeFile).toHaveBeenCalled();
  });
});
