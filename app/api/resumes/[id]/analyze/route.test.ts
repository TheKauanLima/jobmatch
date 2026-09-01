import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireSession,
  mockCreateClient,
  mockGetResumeById,
  mockUpdateResume,
  mockCreateAnalysis,
  mockDownloadResumeFile,
  mockExtractResumeText,
  mockCheckRateLimit,
  mockAnalyzeResume,
  mockParseResumeAnalysisResponse,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
  mockGetResumeById: vi.fn(),
  mockUpdateResume: vi.fn(),
  mockCreateAnalysis: vi.fn(),
  mockDownloadResumeFile: vi.fn(),
  mockExtractResumeText: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockAnalyzeResume: vi.fn(),
  mockParseResumeAnalysisResponse: vi.fn(),
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
  return { ...actual, getResumeById: mockGetResumeById, updateResume: mockUpdateResume };
});

vi.mock("@/lib/supabase/queries/analyses", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/supabase/queries/analyses")
  >("@/lib/supabase/queries/analyses");
  return { ...actual, createAnalysis: mockCreateAnalysis };
});

vi.mock("@/lib/storage/resumeFiles", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/storage/resumeFiles")
  >("@/lib/storage/resumeFiles");
  return {
    ...actual,
    downloadResumeFile: mockDownloadResumeFile,
    extractResumeText: mockExtractResumeText,
  };
});

vi.mock("@/lib/claude/rateLimit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/claude/rateLimit")>(
    "@/lib/claude/rateLimit",
  );
  return { ...actual, checkRateLimit: mockCheckRateLimit };
});

vi.mock("@/lib/claude/prompts/analyzeResume", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/claude/prompts/analyzeResume")
  >("@/lib/claude/prompts/analyzeResume");
  return { ...actual, analyzeResume: mockAnalyzeResume };
});

vi.mock("@/lib/claude/parse", async () => {
  const actual = await vi.importActual<typeof import("@/lib/claude/parse")>(
    "@/lib/claude/parse",
  );
  return { ...actual, parseResumeAnalysisResponse: mockParseResumeAnalysisResponse };
});

const { POST } = await import("@/app/api/resumes/[id]/analyze/route");
const { UnauthorizedError } = await import("@/lib/auth/session");
const { ClaudeApiError } = await import("@/lib/claude/client");
const { ClaudeResponseValidationError } = await import("@/lib/claude/parse");
const { ResumeTextExtractionError, ResumeStorageError } = await import(
  "@/lib/storage/resumeFiles"
);

const RESUME_UUID = "11111111-1111-4111-8111-111111111111";
const fakeUser = { id: "user-1" };

const ownedResumeWithText = {
  id: RESUME_UUID,
  user_id: "user-1",
  storage_path: "user-1/r1.pdf",
  file_name: "resume.pdf",
  file_type: "application/pdf",
  file_size_bytes: 10,
  extracted_text: "Jane Doe, backend engineer.",
  status: "uploaded",
  created_at: "t",
  updated_at: "t",
};

const ownedResumeWithoutText = {
  ...ownedResumeWithText,
  extracted_text: null,
};

const analysisRow = {
  id: "analysis-1",
  resume_id: RESUME_UUID,
  user_id: "user-1",
  strengths: [{ label: "Strong backend", detail: "5 years Node.js" }],
  weaknesses: [],
  summary: "Solid backend engineer.",
  suggested_roles: ["Backend Engineer"],
  model: "claude-sonnet-5",
  created_at: "t",
};

function makeRequest() {
  return new Request(`http://localhost/api/resumes/${RESUME_UUID}/analyze`, {
    method: "POST",
  });
}

function makeContext() {
  return { params: Promise.resolve({ id: RESUME_UUID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateClient.mockResolvedValue({});
  mockUpdateResume.mockResolvedValue({});
  mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
});

describe("POST /api/resumes/:id/analyze — auth & ownership", () => {
  it("returns 401 when unauthenticated, before touching the DB", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(401);
    expect(mockGetResumeById).not.toHaveBeenCalled();
  });

  it("returns 404 when the resume doesn't exist or isn't owned by the caller, never leaking existence", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(null);

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(404);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("returns 500 (not a crash) when fetching the resume throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockRejectedValue(new Error("db down"));

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(500);
  });
});

describe("POST /api/resumes/:id/analyze — rate limiting", () => {
  it("returns 429 with retry_after when the daily analyze rate limit is exceeded, and never calls Claude", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithText);
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      count: 20,
      limit: 20,
      retryAfter: "2026-09-01T00:00:00.000Z",
    });

    const res = await POST(makeRequest(), makeContext());
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.retry_after).toBe("2026-09-01T00:00:00.000Z");
    expect(mockAnalyzeResume).not.toHaveBeenCalled();
    expect(mockDownloadResumeFile).not.toHaveBeenCalled();
  });

  it("checks the rate limit with kind 'analyze'", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithText);
    mockAnalyzeResume.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseResumeAnalysisResponse.mockReturnValue({
      strengths: [],
      weaknesses: [],
      summary: "x",
      suggested_roles: [],
    });
    mockCreateAnalysis.mockResolvedValue(analysisRow);

    await POST(makeRequest(), makeContext());

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({ kind: "analyze" }),
    );
  });

  it("returns 500 (not a crash) when the rate limit check itself throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithText);
    mockCheckRateLimit.mockRejectedValue(new Error("db down"));

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(500);
    expect(mockAnalyzeResume).not.toHaveBeenCalled();
  });
});

describe("POST /api/resumes/:id/analyze — text extraction", () => {
  it("returns 422 when there's no extracted_text and extraction fails (corrupt file)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithoutText);
    mockDownloadResumeFile.mockResolvedValue(Buffer.from("bytes"));
    mockExtractResumeText.mockRejectedValue(
      new ResumeTextExtractionError("Failed to extract text from PDF."),
    );

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(422);
    expect(mockAnalyzeResume).not.toHaveBeenCalled();
    expect(mockUpdateResume).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: "processing" }),
    );
  });

  it("returns 422 when downloading the stored file fails", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithoutText);
    mockDownloadResumeFile.mockRejectedValue(
      new ResumeStorageError("Failed to download resume file from Storage: not found"),
    );

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(422);
    expect(mockAnalyzeResume).not.toHaveBeenCalled();
  });

  it("returns 422 when extraction succeeds but yields only whitespace (garbage/empty resume)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithoutText);
    mockDownloadResumeFile.mockResolvedValue(Buffer.from("bytes"));
    mockExtractResumeText.mockResolvedValue("   \n\t  ");

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(422);
    expect(mockAnalyzeResume).not.toHaveBeenCalled();
  });

  it("extracts text from the stored file on first analysis and persists it alongside the 'processing' status update", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithoutText);
    mockDownloadResumeFile.mockResolvedValue(Buffer.from("bytes"));
    mockExtractResumeText.mockResolvedValue("Newly extracted resume text.");
    mockAnalyzeResume.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseResumeAnalysisResponse.mockReturnValue({
      strengths: [],
      weaknesses: [],
      summary: "x",
      suggested_roles: [],
    });
    mockCreateAnalysis.mockResolvedValue(analysisRow);

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(201);
    expect(mockUpdateResume).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      RESUME_UUID,
      expect.objectContaining({
        status: "processing",
        extractedText: "Newly extracted resume text.",
      }),
    );
    expect(mockAnalyzeResume).toHaveBeenCalledWith("Newly extracted resume text.");
  });

  it("uses the already-stored extracted_text without re-downloading when present", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithText);
    mockAnalyzeResume.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseResumeAnalysisResponse.mockReturnValue({
      strengths: [],
      weaknesses: [],
      summary: "x",
      suggested_roles: [],
    });
    mockCreateAnalysis.mockResolvedValue(analysisRow);

    await POST(makeRequest(), makeContext());

    expect(mockDownloadResumeFile).not.toHaveBeenCalled();
    expect(mockExtractResumeText).not.toHaveBeenCalled();
    expect(mockAnalyzeResume).toHaveBeenCalledWith(ownedResumeWithText.extracted_text);
    // Should not clobber extracted_text with an explicit re-write when it
    // was already present — only 'status: processing' is sent.
    expect(mockUpdateResume).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      RESUME_UUID,
      { status: "processing" },
    );
  });
});

describe("POST /api/resumes/:id/analyze — status state machine & Claude failure handling", () => {
  it("happy path: 201 with the created analysis, status transitions processing -> analyzed", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithText);
    mockAnalyzeResume.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseResumeAnalysisResponse.mockReturnValue({
      strengths: [{ label: "Strong backend", detail: "5 years Node.js" }],
      weaknesses: [],
      summary: "Solid backend engineer.",
      suggested_roles: ["Backend Engineer"],
    });
    mockCreateAnalysis.mockResolvedValue(analysisRow);

    const res = await POST(makeRequest(), makeContext());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.analysis.id).toBe("analysis-1");
    expect(body.analysis.summary).toBe("Solid backend engineer.");

    const statusUpdates = mockUpdateResume.mock.calls.map((call) => call[3]?.status);
    expect(statusUpdates).toEqual(["processing", "analyzed"]);
  });

  it("returns 502 on a Claude API failure and sets resumes.status to 'failed'", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithText);
    mockAnalyzeResume.mockRejectedValue(new ClaudeApiError("Claude API call failed"));

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(502);
    expect(mockCreateAnalysis).not.toHaveBeenCalled();

    const statusUpdates = mockUpdateResume.mock.calls.map((call) => call[3]?.status);
    expect(statusUpdates).toEqual(["processing", "failed"]);
  });

  it("returns 502 and sets status 'failed' when Claude's response fails schema validation", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithText);
    mockAnalyzeResume.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseResumeAnalysisResponse.mockImplementation(() => {
      throw new ClaudeResponseValidationError("bad shape");
    });

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(502);
    expect(mockCreateAnalysis).not.toHaveBeenCalled();

    const statusUpdates = mockUpdateResume.mock.calls.map((call) => call[3]?.status);
    expect(statusUpdates).toEqual(["processing", "failed"]);
  });

  it("returns 502 even when the best-effort 'failed' status update itself fails (never crashes)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithText);
    mockAnalyzeResume.mockRejectedValue(new ClaudeApiError("boom"));
    mockUpdateResume.mockImplementation(async (_client, _userId, _id, patch) => {
      if (patch.status === "failed") {
        throw new Error("db down while marking failed");
      }
      return {};
    });

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(502);
  });

  it("returns 500 (not a crash) on an unexpected non-Claude failure during analysis, and still marks the resume 'failed'", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithText);
    mockAnalyzeResume.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseResumeAnalysisResponse.mockReturnValue({
      strengths: [],
      weaknesses: [],
      summary: "x",
      suggested_roles: [],
    });
    mockCreateAnalysis.mockRejectedValue(new Error("unexpected db failure"));

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(500);
    const statusUpdates = mockUpdateResume.mock.calls.map((call) => call[3]?.status);
    expect(statusUpdates).toEqual(["processing", "failed"]);
  });

  it("still returns 201 with the analysis when the final 'analyzed' status update fails (best-effort, non-gating per the M3 fix)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithText);
    mockAnalyzeResume.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseResumeAnalysisResponse.mockReturnValue({
      strengths: [],
      weaknesses: [],
      summary: "x",
      suggested_roles: [],
    });
    mockCreateAnalysis.mockResolvedValue(analysisRow);
    mockUpdateResume.mockImplementation(async (_client, _userId, _id, patch) => {
      if (patch.status === "analyzed") {
        throw new Error("db hiccup marking analyzed");
      }
      return {};
    });

    const res = await POST(makeRequest(), makeContext());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.analysis.id).toBe("analysis-1");
  });

  it("returns 500 (not a crash) when marking the resume 'processing' fails, before ever calling Claude", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResumeWithText);
    mockUpdateResume.mockRejectedValue(new Error("db down"));

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(500);
    expect(mockAnalyzeResume).not.toHaveBeenCalled();
  });
});
