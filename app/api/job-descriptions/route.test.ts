import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireSession,
  mockCreateClient,
  mockListJobDescriptions,
  mockCreateJobDescription,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
  mockListJobDescriptions: vi.fn(),
  mockCreateJobDescription: vi.fn(),
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
    listJobDescriptions: mockListJobDescriptions,
    createJobDescription: mockCreateJobDescription,
  };
});

const { GET, POST } = await import("@/app/api/job-descriptions/route");
const { UnauthorizedError } = await import("@/lib/auth/session");

const fakeUser = { id: "user-1" };

const row = {
  id: "jd-1",
  submitted_by: "user-1",
  title: "Software Engineer",
  company: "Acme",
  description: "Build things.",
  source_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function makeRequest(url: string, init?: RequestInit) {
  return new Request(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateClient.mockResolvedValue({});
});

describe("GET /api/job-descriptions", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await GET(makeRequest("http://localhost/api/job-descriptions"));
    expect(res.status).toBe(401);
  });

  it("lists shared job descriptions and returns next_cursor: null when there's no more data", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockResolvedValue({ items: [row], hasMore: false });

    const res = await GET(makeRequest("http://localhost/api/job-descriptions"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.job_descriptions).toHaveLength(1);
    expect(body.job_descriptions[0].id).toBe("jd-1");
    expect(body.next_cursor).toBeNull();
  });

  it("returns next_cursor as the encoded (created_at, id) cursor of the last item when hasMore is true", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockResolvedValue({ items: [row], hasMore: true });

    const res = await GET(makeRequest("http://localhost/api/job-descriptions"));
    const body = await res.json();

    expect(body.next_cursor).toBe(`${row.created_at}_${row.id}`);
  });

  it("passes limit and cursor query params through to the query layer", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    await GET(
      makeRequest(
        "http://localhost/api/job-descriptions?limit=5&cursor=2026-01-01T00%3A00%3A00.000Z",
      ),
    );

    expect(mockListJobDescriptions).toHaveBeenCalledWith(expect.anything(), {
      limit: 5,
      cursor: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns 400 for a non-numeric limit", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?limit=abc"),
    );
    expect(res.status).toBe(400);
    expect(mockListJobDescriptions).not.toHaveBeenCalled();
  });

  it("returns 400 for limit=0", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?limit=0"),
    );
    expect(res.status).toBe(400);
    expect(mockListJobDescriptions).not.toHaveBeenCalled();
  });

  it("returns 400 for a negative limit", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?limit=-5"),
    );
    expect(res.status).toBe(400);
    expect(mockListJobDescriptions).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-integer (decimal) limit", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?limit=1.5"),
    );
    expect(res.status).toBe(400);
    expect(mockListJobDescriptions).not.toHaveBeenCalled();
  });

  it("silently clamps a limit above JOB_DESCRIPTIONS_MAX_LIMIT instead of erroring", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?limit=99999"),
    );
    expect(res.status).toBe(200);
    expect(mockListJobDescriptions).toHaveBeenCalledWith(expect.anything(), {
      limit: 100,
      cursor: null,
    });
  });

  it("returns 500 (not a crash) when the query layer throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest("http://localhost/api/job-descriptions"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/job-descriptions", () => {
  it("returns 401 when unauthenticated, before touching the DB", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await POST(
      makeRequest("http://localhost/api/job-descriptions", {
        method: "POST",
        body: JSON.stringify({ title: "t", description: "d" }),
      }),
    );

    expect(res.status).toBe(401);
    expect(mockCreateJobDescription).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-JSON body", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await POST(
      makeRequest("http://localhost/api/job-descriptions", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an empty title", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await POST(
      makeRequest("http://localhost/api/job-descriptions", {
        method: "POST",
        body: JSON.stringify({ title: "", description: "d" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(mockCreateJobDescription).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty description", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await POST(
      makeRequest("http://localhost/api/job-descriptions", {
        method: "POST",
        body: JSON.stringify({ title: "t", description: "" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(mockCreateJobDescription).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing title/description", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await POST(
      makeRequest("http://localhost/api/job-descriptions", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a job description with submitted_by set to the caller, not a client-supplied value", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockCreateJobDescription.mockResolvedValue(row);

    const res = await POST(
      makeRequest("http://localhost/api/job-descriptions", {
        method: "POST",
        body: JSON.stringify({
          title: "Software Engineer",
          company: "Acme",
          description: "Build things.",
          submitted_by: "attacker-user",
        }),
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.job_description.id).toBe("jd-1");
    expect(mockCreateJobDescription).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ submittedBy: "user-1" }),
    );
  });

  it("returns 500 (not a crash) when the query layer throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockCreateJobDescription.mockRejectedValue(new Error("db down"));

    const res = await POST(
      makeRequest("http://localhost/api/job-descriptions", {
        method: "POST",
        body: JSON.stringify({ title: "t", description: "d" }),
      }),
    );
    expect(res.status).toBe(500);
  });
});
