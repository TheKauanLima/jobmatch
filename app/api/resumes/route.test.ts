import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireSession,
  mockCreateClient,
  mockListResumesForUser,
  mockCreateResume,
  mockUploadResumeFile,
  mockDeleteResumeFile,
  mockExtractResumeText,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
  mockListResumesForUser: vi.fn(),
  mockCreateResume: vi.fn(),
  mockUploadResumeFile: vi.fn(),
  mockDeleteResumeFile: vi.fn(),
  mockExtractResumeText: vi.fn(),
}));

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>(
    "@/lib/auth/session",
  );
  return {
    ...actual,
    requireSession: mockRequireSession,
  };
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
    listResumesForUser: mockListResumesForUser,
    createResume: mockCreateResume,
  };
});

vi.mock("@/lib/storage/resumeFiles", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/storage/resumeFiles")
  >("@/lib/storage/resumeFiles");
  return {
    ...actual,
    uploadResumeFile: mockUploadResumeFile,
    deleteResumeFile: mockDeleteResumeFile,
    extractResumeText: mockExtractResumeText,
  };
});

const { GET, POST } = await import("@/app/api/resumes/route");
const { UnauthorizedError } = await import("@/lib/auth/session");

const fakeUser = { id: "user-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateClient.mockResolvedValue({});
});

describe("GET /api/resumes", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await GET();

    expect(res.status).toBe(401);
  });

  it("lists only the caller's resumes and omits extracted_text from list items", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListResumesForUser.mockResolvedValue([
      {
        id: "r1",
        user_id: "user-1",
        storage_path: "user-1/r1.pdf",
        file_name: "resume.pdf",
        file_type: "application/pdf",
        file_size_bytes: 10,
        extracted_text: "super secret resume content",
        status: "uploaded",
        created_at: "t",
        updated_at: "t",
      },
    ]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockListResumesForUser).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
    expect(body.resumes).toHaveLength(1);
    expect(body.resumes[0]).not.toHaveProperty("extracted_text");
    expect(body.resumes[0]).not.toHaveProperty("storage_path");
    expect(body.resumes[0]).not.toHaveProperty("user_id");
  });

  it("returns 500 (not a crash) when the query layer throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListResumesForUser.mockRejectedValue(new Error("db down"));

    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

function makeUploadRequest(file: File | null) {
  const formData = new FormData();
  if (file) formData.append("file", file);
  return new Request("http://localhost/api/resumes", {
    method: "POST",
    body: formData,
  });
}

describe("POST /api/resumes", () => {
  it("returns 401 when unauthenticated, before touching storage", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await POST(makeUploadRequest(null));

    expect(res.status).toBe(401);
    expect(mockUploadResumeFile).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing file field", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await POST(makeUploadRequest(null));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a disallowed MIME type without ever calling Storage", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    const file = new File(["data"], "resume.exe", {
      type: "application/x-msdownload",
    });

    const res = await POST(makeUploadRequest(file));

    expect(res.status).toBe(400);
    expect(mockUploadResumeFile).not.toHaveBeenCalled();
  });

  it("returns 400 for an oversized file without calling Storage", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const file = new File([big], "huge.pdf", { type: "application/pdf" });

    const res = await POST(makeUploadRequest(file));

    expect(res.status).toBe(400);
    expect(mockUploadResumeFile).not.toHaveBeenCalled();
  });

  it("uploads successfully and falls back to extracted_text: null when extraction throws (does not 500)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockUploadResumeFile.mockResolvedValue({
      resumeId: "r1",
      storagePath: "user-1/r1.pdf",
    });
    mockExtractResumeText.mockRejectedValue(new Error("corrupt pdf"));
    mockCreateResume.mockResolvedValue({
      id: "r1",
      user_id: "user-1",
      storage_path: "user-1/r1.pdf",
      file_name: "resume.pdf",
      file_type: "application/pdf",
      file_size_bytes: 4,
      extracted_text: null,
      status: "uploaded",
      created_at: "t",
      updated_at: "t",
    });

    const file = new File(["data"], "resume.pdf", { type: "application/pdf" });
    const res = await POST(makeUploadRequest(file));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.resume.id).toBe("r1");
    expect(mockCreateResume).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ extractedText: null }),
    );
    // Never rolled back on a successful insert.
    expect(mockDeleteResumeFile).not.toHaveBeenCalled();
  });

  it("rolls back the orphaned Storage object when the DB insert fails", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockUploadResumeFile.mockResolvedValue({
      resumeId: "r1",
      storagePath: "user-1/r1.pdf",
    });
    mockExtractResumeText.mockResolvedValue("some text");
    mockCreateResume.mockRejectedValue(new Error("insert failed"));
    mockDeleteResumeFile.mockResolvedValue(undefined);

    const file = new File(["data"], "resume.pdf", { type: "application/pdf" });
    const res = await POST(makeUploadRequest(file));

    expect(res.status).toBe(500);
    expect(mockDeleteResumeFile).toHaveBeenCalledWith(
      expect.anything(),
      "user-1/r1.pdf",
    );
  });

  it("still returns 500 (not a crash) when both the DB insert AND the rollback delete fail", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockUploadResumeFile.mockResolvedValue({
      resumeId: "r1",
      storagePath: "user-1/r1.pdf",
    });
    mockExtractResumeText.mockResolvedValue("some text");
    mockCreateResume.mockRejectedValue(new Error("insert failed"));
    mockDeleteResumeFile.mockRejectedValue(new Error("storage also down"));

    const file = new File(["data"], "resume.pdf", { type: "application/pdf" });
    const res = await POST(makeUploadRequest(file));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});
