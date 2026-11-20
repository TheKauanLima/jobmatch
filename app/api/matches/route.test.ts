import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireSession,
  mockCreateClient,
  mockGetResumeById,
  mockGetLatestAnalysis,
  mockGetJobDescriptionById,
  mockListMatchesForResume,
  mockListRecentMatchesForUser,
  mockCreateMatch,
  mockCheckRateLimit,
  mockMatchResumeToJob,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
  mockGetResumeById: vi.fn(),
  mockGetLatestAnalysis: vi.fn(),
  mockGetJobDescriptionById: vi.fn(),
  mockListMatchesForResume: vi.fn(),
  mockListRecentMatchesForUser: vi.fn(),
  mockCreateMatch: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockMatchResumeToJob: vi.fn(),
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
    listRecentMatchesForUser: mockListRecentMatchesForUser,
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

const routeModule = await import("@/app/api/matches/route");
const { GET, POST } = routeModule;
const { UnauthorizedError } = await import("@/lib/auth/session");
const {
  ClaudeApiError,
  ClaudeBadRequestError,
  ClaudeInvalidOutputError,
  ClaudeRefusalError,
  ClaudeTruncatedError,
} = await import("@/lib/claude/errors");

/** Shape returned by the migrated `matchResumeToJob` (lib/claude/prompts/matchResumeToJob.ts). */
function outcome(value: unknown) {
  return {
    value,
    dropped: 0,
    model: "claude-opus-5-5",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, priceKnown: true },
    requestId: "req_test",
  };
}

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
  deleted_at: null,
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

describe("GET /api/matches (no resume_id) — cross-resume recent matches", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const res = await GET(getRequest(""));
    expect(res.status).toBe(401);
  });

  it("lists the caller's recent matches across resumes, with job_description and resume inlined", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListRecentMatchesForUser.mockResolvedValue({
      items: [
        {
          ...matchRow,
          job_description: {
            id: JOB_DESCRIPTION_UUID,
            title: "Backend Engineer",
            company: "Acme",
            deleted_at: null,
          },
          resume: { id: RESUME_UUID, file_name: "resume.pdf" },
        },
      ],
      hasMore: false,
    });

    const res = await GET(getRequest(""));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].resume).toEqual({ id: RESUME_UUID, file_name: "resume.pdf" });
    expect(body.next_cursor).toBeNull();
    expect(mockGetResumeById).not.toHaveBeenCalled();
    expect(mockListMatchesForResume).not.toHaveBeenCalled();
  });

  it("defaults to RECENT_MATCHES_DEFAULT_LIMIT and clamps a huge limit to RECENT_MATCHES_MAX_LIMIT", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListRecentMatchesForUser.mockResolvedValue({ items: [], hasMore: false });

    await GET(getRequest(""));
    expect(mockListRecentMatchesForUser).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      { limit: 5, cursor: null },
    );

    await GET(getRequest("?limit=9999"));
    expect(mockListRecentMatchesForUser).toHaveBeenLastCalledWith(
      expect.anything(),
      "user-1",
      { limit: 50, cursor: null },
    );
  });

  it("returns 400 for a non-positive-integer limit", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await GET(getRequest("?limit=abc"));
    expect(res.status).toBe(400);
    expect(mockListRecentMatchesForUser).not.toHaveBeenCalled();
  });

  it("returns 500 (not a crash) when the query layer throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListRecentMatchesForUser.mockRejectedValue(new Error("db down"));

    const res = await GET(getRequest(""));
    expect(res.status).toBe(500);
  });

  it("passes ?cursor= through verbatim to listRecentMatchesForUser", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListRecentMatchesForUser.mockResolvedValue({ items: [], hasMore: false });

    await GET(getRequest("?cursor=2026-01-01T00%3A00%3A00.000Z_11111111-1111-1111-1111-111111111111"));

    expect(mockListRecentMatchesForUser).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      {
        limit: 5,
        cursor: "2026-01-01T00:00:00.000Z_11111111-1111-1111-1111-111111111111",
      },
    );
  });

  it("returns next_cursor derived from the last item when hasMore is true, and null when hasMore is false", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    const lastItem = {
      ...matchRow,
      id: "match-last",
      created_at: "2026-03-01T00:00:00.000Z",
      job_description: {
        id: JOB_DESCRIPTION_UUID,
        title: "Backend Engineer",
        company: "Acme",
        deleted_at: null,
      },
      resume: { id: RESUME_UUID, file_name: "resume.pdf" },
    };

    mockListRecentMatchesForUser.mockResolvedValue({ items: [lastItem], hasMore: true });
    const res = await GET(getRequest(""));
    const body = await res.json();

    expect(body.next_cursor).toBe("2026-03-01T00:00:00.000Z_match-last");

    mockListRecentMatchesForUser.mockResolvedValue({ items: [lastItem], hasMore: false });
    const res2 = await GET(getRequest(""));
    const body2 = await res2.json();

    expect(body2.next_cursor).toBeNull();
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

  it("returns 400 when the job description has been soft-deleted (per docs/ARCHITECTURE.md §10.3 — can't become the target of a NEW match)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue({
      ...jobDescription,
      deleted_at: "2026-02-01T00:00:00.000Z",
    });

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );

    expect(res.status).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockMatchResumeToJob).not.toHaveBeenCalled();
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
    mockMatchResumeToJob.mockResolvedValue(outcome({
      score: 82,
      rationale: "Good fit.",
      matched_strengths: ["Node.js"],
      gaps: ["Kubernetes"],
    }));
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
    mockMatchResumeToJob.mockResolvedValue(outcome({
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

    expect(mockMatchResumeToJob).toHaveBeenCalledWith(
      ownedResume.extracted_text,
      jobDescription.description,
      { userId: "user-1", signal: expect.any(AbortSignal) },
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
      deleted_at: null,
    });
    expect(body.match.score).toBe(82);
  });

  it("returns 502 when the Claude API is unavailable, calling the task once", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockRejectedValue(new ClaudeApiError("Claude unavailable.", { code: "ai_unavailable", retryable: true, status: 529 }));

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(502);
    expect(mockCreateMatch).not.toHaveBeenCalled();
    expect(mockMatchResumeToJob).toHaveBeenCalledTimes(1);
  });

  it("returns 502 when Claude's output is invalid (after matchResumeToJob's own single retry); the route has no retry loop of its own (MAX_MATCH_ATTEMPTS removed in M1.1)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockRejectedValue(
      new ClaudeInvalidOutputError("Claude output failed validation (matchResumeToJob: schema mismatch at score)."),
    );

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Match assessment failed. Please try again." });
    expect(mockCreateMatch).not.toHaveBeenCalled();
    expect(mockMatchResumeToJob).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["refusal", () => new ClaudeRefusalError("Claude declined the request.", { category: "general_harms" })],
    ["truncation", () => new ClaudeTruncatedError("Claude output was truncated.")],
    ["bad request", () => new ClaudeBadRequestError("Claude rejected the request.", { status: 400 })],
    ["rate limit / overload", () => new ClaudeApiError("Claude rate limited.", { code: "ai_unavailable", retryable: true, status: 429 })],
  ])("maps a Claude %s to 502 without persisting", async (_name, makeErr) => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockRejectedValue(makeErr());

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(502);
    expect(mockCreateMatch).not.toHaveBeenCalled();
  });

  it("persists the validated value and the model that actually served the response", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    const value = { score: 82, rationale: "Good fit.", matched_strengths: ["Node.js"], gaps: ["Kubernetes"] };
    mockMatchResumeToJob.mockResolvedValue({ ...outcome(value), model: "claude-sonnet-5-5" });
    mockCreateMatch.mockResolvedValue(matchRow);

    await POST(postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }));

    expect(mockCreateMatch).toHaveBeenCalledWith(expect.anything(), {
      resumeId: RESUME_UUID,
      jobDescriptionId: JOB_DESCRIPTION_UUID,
      userId: "user-1",
      model: "claude-sonnet-5-5",
      result: value,
    });
  });

  it("never logs resume or job description text when Claude fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockRejectedValue(new ClaudeTruncatedError("Claude output was truncated."));

    await POST(postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }));

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain("ai_truncated");
    expect(logged).not.toContain(ownedResume.extracted_text);
    expect(logged).not.toContain(jobDescription.description);
    errorSpy.mockRestore();
  });

  it("returns 500 (not a crash) on an unexpected DB failure creating the match", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockResolvedValue(outcome({
      score: 82,
      rationale: "Good fit.",
      matched_strengths: [],
      gaps: [],
    }));
    mockCreateMatch.mockRejectedValue(new Error("db down"));

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );
    expect(res.status).toBe(500);
  });
});

describe("POST /api/matches — deadline (review B1)", () => {
  it("exports maxDuration = 300, above the 270 s Claude deadline", () => {
    expect(routeModule.maxDuration).toBe(300);
  });

  it("when the deadline fires mid-assessment: JSON 502 and nothing persisted", async () => {
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetResumeById.mockResolvedValue(ownedResume);
    mockGetLatestAnalysis.mockResolvedValue(someAnalysis);
    mockGetJobDescriptionById.mockResolvedValue(jobDescription);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, count: 0, limit: 20 });
    mockMatchResumeToJob.mockImplementation(
      (_r: string, _j: string, ctx: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () =>
            reject(
              new ClaudeApiError("Claude call aborted (matchResumeToJob).", {
                code: "ai_unavailable",
                retryable: true,
              }),
            ),
          );
          setTimeout(() => deadline.abort(), 0);
        }),
    );

    const res = await POST(
      postRequest({ resume_id: RESUME_UUID, job_description_id: JOB_DESCRIPTION_UUID }),
    );

    expect(timeoutSpy).toHaveBeenCalledWith(270_000);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Match assessment failed. Please try again." });
    expect(mockCreateMatch).not.toHaveBeenCalled();
    timeoutSpy.mockRestore();
  });
});
