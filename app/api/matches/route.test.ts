import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireSession,
  mockCreateClient,
  mockGetResumeById,
  mockGetLatestAnalysis,
  mockGetJobDescriptionById,
  mockListMatchesForResume,
  mockCreateMatch,
  mockCheckRateLimit,
  mockMatchResumeToJob,
  mockParseMatchResponse,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
  mockGetResumeById: vi.fn(),
  mockGetLatestAnalysis: vi.fn(),
  mockGetJobDescriptionById: vi.fn(),
  mockListMatchesForResume: vi.fn(),
  mockCreateMatch: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockMatchResumeToJob: vi.fn(),
  mockParseMatchResponse: vi.fn(),
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

vi.mock("@/lib/supabase/queries/jobDescriptions", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/supabase/queries/jobDescriptions")
  >("@/lib/supabase/queries/jobDescriptions");
  return { ...actual, getJobDescriptionById: mockGetJobDescriptionById };
});

vi.mock("@/lib/supabase/queries/matches", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/supabase/queries/matches")
  >("@/lib/supabase/queries/matches");
  return {
    ...actual,
    listMatchesForResume: mockListMatchesForResume,
    createMatch: mockCreateMatch,
  };
});

vi.mock("@/lib/claude/rateLimit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/claude/rateLimit")>(
    "@/lib/claude/rateLimit",
  );
  return { ...actual, checkRateLimit: mockCheckRateLimit };
});

vi.mock("@/lib/claude/prompts/matchResumeToJob", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/claude/prompts/matchResumeToJob")
  >("@/lib/claude/prompts/matchResumeToJob");
  return { ...actual, matchResumeToJob: mockMatchResumeToJob };
});

vi.mock("@/lib/claude/parse", async () => {
  const actual = await vi.importActual<typeof import("@/lib/claude/parse")>(
    "@/lib/claude/parse",
  );
  return { ...actual, parseMatchResponse: mockParseMatchResponse };
});

const { GET, POST } = await import("@/app/api/matches/route");
const { UnauthorizedError } = await import("@/lib/auth/session");
const { ClaudeApiError } = await import("@/lib/claude/client");
const { ClaudeResponseValidationError } = await import("@/lib/claude/parse");

const RESUME_UUID = "11111111-1111-4111-8111-111111111111";
const JOB_DESCRIPTION_UUID = "22222222-2222-4222-8222-222222222222";

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

const someAnalysis = {
  id: "analysis-1",
  resume_id: RESUME_UUID,
  user_id: "user-1",
  strengths: [],
  weaknesses: [],
  summary: "x",
  suggested_roles: [],
  model: "claude-sonnet-5",
  created_at: "t",
};

const jobDescription = {
  id: JOB_DESCRIPTION_UUID,
  submitted_by: "user-2",
  title: "Backend Engineer",
  company: "Acme",
  description: "Build things.",
  source_url: null,
  created_at: "t",
  updated_at: "t",
};

const matchRow = {
  id: "match-1",
  resume_id: RESUME_UUID,
  job_description_id: JOB_DESCRIPTION_UUID,
  user_id: "user-1",
  score: 82,
  rationale: "Good fit.",
  matched_strengths: ["Node.js"],
  gaps: ["Kubernetes"],
  model: "claude-sonnet-5",
  created_at: "t",
};

function postRequest(body: unknown) {
  return new Request("http://localhost/api/matches", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function getRequest(query: string) {
  return new Request(`http://localhost/api/matches${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateClient.mockResolvedValue({});
  // Sensible default for POST tests that aren't specifically exercising the
  // "not yet analyzed" 400 path — individual tests override this.
  mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
});

describe("GET /api/matches — privacy boundary", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const res = await GET(getRequest(`?resume_id=${RESUME_UUID}`));
    expect(res.status).toBe(401);
  });

  it("returns 400 when resume_id is missing (no listing mode without it)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    const res = await GET(getRequest(""));
    expect(res.status).toBe(400);
    expect(mockListMatchesForResume).not.toHaveBeenCalled();
  });

  it("returns 404 when the resume doesn't exist or isn't owned by the caller — never leaking other users' match data", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(null);

    const res = await GET(getRequest(`?resume_id=${RESUME_UUID}`));
    expect(res.status).toBe(404);
    expect(mockListMatchesForResume).not.toHaveBeenCalled();
  });

  it("lists matches scoped to the caller's own resume, with job_description inlined", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockListMatchesForResume.mockResolvedValue([
      { ...matchRow, job_description: { id: JOB_DESCRIPTION_UUID, title: "Backend Engineer", company: "Acme" } },
    ]);

    const res = await GET(getRequest(`?resume_id=${RESUME_UUID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].job_description).toEqual({
      id: JOB_DESCRIPTION_UUID,
      title: "Backend Engineer",
      company: "Acme",
    });
    expect(mockListMatchesForResume).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      RESUME_UUID,
    );
  });

  it("returns 500 (not a crash) when the query layer throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockListMatchesForResume.mockRejectedValue(new Error("db down"));

    const res = await GET(getRequest(`?resume_id=${RESUME_UUID}`));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/matches", () => {
  it("returns 401 when unauthenticated, before touching the DB", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(401);
    expect(mockGetResumeById).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-JSON body", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    const res = await POST(
      new Request("http://localhost/api/matches", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed resume_id/job_description_id (not a uuid)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    const res = await POST(postRequest({ resume_id: "not-a-uuid", job_description_id: JOB_DESCRIPTION_UUID }));
    expect(res.status).toBe(400);
    expect(mockGetResumeById).not.toHaveBeenCalled();
  });

  it("returns 404 when the resume doesn't exist or isn't owned by the caller (pre-check, per docs/ARCHITECTURE.md §2)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(null);

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(404);
    expect(mockGetLatestAnalysis).not.toHaveBeenCalled();
  });

  it("returns 400 when the resume has no analysis yet (must be analyzed before matching)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(null);

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(400);
    expect(mockGetJobDescriptionById).not.toHaveBeenCalled();
  });

  it("returns 400 when the resume has an analysis row but no extracted_text (defensive)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue({ ...ownedResume, extracted_text: null });
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the job description doesn't exist", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(null);

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(404);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("returns 429 with retry_after when the daily match rate limit is exceeded, before calling Claude", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      count: 20,
      limit: 20,
      retryAfter: "2026-09-01T00:00:00.000Z",
    });

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.retry_after).toBe("2026-09-01T00:00:00.000Z");
    expect(mockMatchResumeToJob).not.toHaveBeenCalled();
  });

  it("checks the rate limit with kind 'match'", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseMatchResponse.mockReturnValue({
      score: 82,
      rationale: "Good fit.",
      matched_strengths: ["Node.js"],
      gaps: ["Kubernetes"],
    });
    mockCreateMatch.mockResolvedValue(matchRow);

    await POST(postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }));

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({ kind: "match" }),
    );
  });

  it("calls Claude with the resume's extracted_text and the job description's description, then persists and returns 201 with job_description inlined", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseMatchResponse.mockReturnValue({
      score: 82,
      rationale: "Good fit.",
      matched_strengths: ["Node.js"],
      gaps: ["Kubernetes"],
    });
    mockCreateMatch.mockResolvedValue(matchRow);

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    const body = await res.json();

    expect(mockMatchResumeToJob).toHaveBeenCalledWith(
      ownedResume.extracted_text,
      jobDescription.description,
    );
    expect(mockCreateMatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resumeId: RESUME_UUID,
        jobDescriptionId: JOB_DESCRIPTION_UUID,
        userId: "user-1",
      }),
    );
    expect(res.status).toBe(201);
    expect(body.match.job_description).toEqual({
      id: JOB_DESCRIPTION_UUID,
      title: "Backend Engineer",
      company: "Acme",
    });
    expect(body.match.score).toBe(82);
  });

  it("returns 502 when the Claude API call fails, WITHOUT retrying (ClaudeApiError is not retried, only schema-validation failures are)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockRejectedValue(new ClaudeApiError("boom"));

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(502);
    expect(mockCreateMatch).not.toHaveBeenCalled();
    expect(mockMatchResumeToJob).toHaveBeenCalledTimes(1);
  });

  it("returns 502 when Claude's response fails schema validation on every attempt, after retrying up to the bounded max", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseMatchResponse.mockImplementation(() => {
      throw new ClaudeResponseValidationError("bad shape");
    });

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(502);
    expect(mockCreateMatch).not.toHaveBeenCalled();
    // Bounded retry: 1 initial attempt + up to 3 retries = 4 total calls,
    // not an unbounded retry loop.
    expect(mockMatchResumeToJob).toHaveBeenCalledTimes(4);
    expect(mockParseMatchResponse).toHaveBeenCalledTimes(4);
  });

  it("recovers via retry: a schema-invalid response on the first attempt followed by a valid response on the second attempt succeeds with 201 (regression test for the QA-reported bug — no retry previously existed)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseMatchResponse
      .mockImplementationOnce(() => {
        // Reproduces the QA-reported non-compliant response: matched_strengths
        // as a string instead of an array, gaps omitted.
        throw new ClaudeResponseValidationError(
          "matched_strengths must be an array, gaps is required",
        );
      })
      .mockImplementationOnce(() => ({
        score: 82,
        rationale: "Good fit.",
        matched_strengths: ["Node.js"],
        gaps: ["Kubernetes"],
      }));
    mockCreateMatch.mockResolvedValue(matchRow);

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.match.score).toBe(82);
    expect(mockMatchResumeToJob).toHaveBeenCalledTimes(2);
    expect(mockCreateMatch).toHaveBeenCalledTimes(1);
  });

  it("returns 500 (not a crash) on an unexpected DB failure creating the match", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockResolvedValue({ model: "claude-sonnet-5" });
    mockParseMatchResponse.mockReturnValue({
      score: 82,
      rationale: "Good fit.",
      matched_strengths: [],
      gaps: [],
    });
    mockCreateMatch.mockRejectedValue(new Error("db down"));

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(500);
  });
});
