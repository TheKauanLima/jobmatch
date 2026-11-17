import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireSession,
  mockCreateClient,
  mockListJobDescriptions,
  mockCreateJobListing,
  mockSearchJobDescriptions,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
  mockListJobDescriptions: vi.fn(),
  mockCreateJobListing: vi.fn(),
  mockSearchJobDescriptions: vi.fn(),
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
    createJobListing: mockCreateJobListing,
    searchJobDescriptions: mockSearchJobDescriptions,
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
  source: "user",
  external_id: null,
  level: null,
  location: null,
  posted_at: null,
  deleted_at: null,
  visibility: "shared",
  owner_user_id: null,
  source_board: null,
  apply_url: null,
  employment_type: null,
  remote_type: null,
  location_country: null,
  salary_min: null,
  salary_max: null,
  salary_currency: null,
  salary_period: null,
  last_seen_at: null,
  expires_at: "2026-03-02T00:00:00.000Z",
  closed_at: null,
  closed_reason: null,
  content_hash: "hash",
  dedupe_key: null,
  duplicate_of: null,
  source_metadata: {},
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
      level: null,
      scope: "shared",
      callerId: "user-1",
    });
  });

  it("passes the level query param through to the query layer", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    await GET(
      makeRequest("http://localhost/api/job-descriptions?level=Internship"),
    );

    expect(mockListJobDescriptions).toHaveBeenCalledWith(expect.anything(), {
      limit: 20,
      cursor: null,
      level: "Internship",
      scope: "shared",
      callerId: "user-1",
    });
  });

  it("passes level: null through when no level query param is given", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    await GET(makeRequest("http://localhost/api/job-descriptions"));

    expect(mockListJobDescriptions).toHaveBeenCalledWith(expect.anything(), {
      limit: 20,
      cursor: null,
      level: null,
      scope: "shared",
      callerId: "user-1",
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
      level: null,
      scope: "shared",
      callerId: "user-1",
    });
  });

  it("returns 500 (not a crash) when the query layer throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest("http://localhost/api/job-descriptions"));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/job-descriptions with ?q= (search mode, per docs/ARCHITECTURE.md §9)", () => {
  it("routes to searchJobDescriptions (not listJobDescriptions) when q is present", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockSearchJobDescriptions.mockResolvedValue({ items: [row], hasMore: false });

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?q=engineer"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockSearchJobDescriptions).toHaveBeenCalledWith(expect.anything(), {
      query: "engineer",
      limit: 20,
      offset: 0,
      level: null,
      scope: "shared",
    });
    expect(mockListJobDescriptions).not.toHaveBeenCalled();
    expect(body.job_descriptions).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
  });

  it("combines q and level, passing both through to searchJobDescriptions", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockSearchJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    await GET(
      makeRequest(
        "http://localhost/api/job-descriptions?q=engineer&level=Internship",
      ),
    );

    expect(mockSearchJobDescriptions).toHaveBeenCalledWith(expect.anything(), {
      query: "engineer",
      limit: 20,
      offset: 0,
      level: "Internship",
      scope: "shared",
    });
  });

  it("returns 400 when q exceeds JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await GET(
      makeRequest(
        `http://localhost/api/job-descriptions?q=${"a".repeat(201)}`,
      ),
    );

    expect(res.status).toBe(400);
    expect(mockSearchJobDescriptions).not.toHaveBeenCalled();
    expect(mockListJobDescriptions).not.toHaveBeenCalled();
  });

  it("accepts q at exactly JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH (boundary, not an off-by-one 400)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockSearchJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    const res = await GET(
      makeRequest(
        `http://localhost/api/job-descriptions?q=${"a".repeat(200)}`,
      ),
    );

    expect(res.status).toBe(200);
    expect(mockSearchJobDescriptions).toHaveBeenCalled();
  });

  it("treats an empty q (?q=) as no filter and falls back to listJobDescriptions", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    const res = await GET(makeRequest("http://localhost/api/job-descriptions?q="));

    expect(res.status).toBe(200);
    expect(mockSearchJobDescriptions).not.toHaveBeenCalled();
    expect(mockListJobDescriptions).toHaveBeenCalledWith(expect.anything(), {
      limit: 20,
      cursor: null,
      level: null,
      scope: "shared",
      callerId: "user-1",
    });
  });

  it("treats a whitespace-only q (?q=%20%20) as no filter and falls back to listJobDescriptions", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?q=%20%20%20"),
    );

    expect(res.status).toBe(200);
    expect(mockSearchJobDescriptions).not.toHaveBeenCalled();
    expect(mockListJobDescriptions).toHaveBeenCalled();
  });

  it("trims surrounding whitespace from a non-empty q before searching", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockSearchJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    await GET(
      makeRequest("http://localhost/api/job-descriptions?q=%20engineer%20"),
    );

    expect(mockSearchJobDescriptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ query: "engineer" }),
    );
  });

  it("decodes a search-mode (offset) cursor and passes the offset through", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockSearchJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    await GET(
      makeRequest(
        "http://localhost/api/job-descriptions?q=engineer&cursor=offset_40",
      ),
    );

    expect(mockSearchJobDescriptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ offset: 40 }),
    );
  });

  it("returns next_cursor as an encoded offset cursor when hasMore is true", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockSearchJobDescriptions.mockResolvedValue({ items: [row], hasMore: true });

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?q=engineer"),
    );
    const body = await res.json();

    expect(body.next_cursor).toBe("offset_1");
  });

  // §9.2's documented contract: a cursor from the OTHER pagination mode
  // (here, a keyset `<created_at>_<id>` cursor from the non-search listing)
  // replayed on a request that now has `q=` must degrade to page 1 (offset
  // 0), not error and not silently misinterpret the string as an offset.
  it("degrades to offset 0 (first page) when a keyset cursor is replayed on a q= request", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockSearchJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    const keysetCursor = `2026-01-01T00:00:00.000Z_${row.id}`;
    await GET(
      makeRequest(
        `http://localhost/api/job-descriptions?q=engineer&cursor=${encodeURIComponent(keysetCursor)}`,
      ),
    );

    expect(mockSearchJobDescriptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ offset: 0 }),
    );
  });

  // The reverse direction of the above: an offset cursor (search mode)
  // replayed on a request with no `q=` must degrade to "no cursor" (first
  // page) in the keyset listing path, not error.
  it("degrades to first page when an offset cursor is replayed on a request with no q=", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockResolvedValue({ items: [], hasMore: false });

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?cursor=offset_40"),
    );

    expect(res.status).toBe(200);
    // The route passes the raw cursor string through to listJobDescriptions,
    // which internally fails to decode it as a keyset cursor and applies no
    // filter — asserting the cursor is passed through verbatim here, and
    // relying on jobDescriptions.test.ts's own coverage that
    // decodeJobDescriptionCursor("offset_40") -> null.
    expect(mockListJobDescriptions).toHaveBeenCalledWith(expect.anything(), {
      limit: 20,
      cursor: "offset_40",
      level: null,
      scope: "shared",
      callerId: "user-1",
    });
  });

  it("response envelope shape (job_descriptions/next_cursor keys) matches the non-search mode", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockSearchJobDescriptions.mockResolvedValue({ items: [row], hasMore: false });

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?q=engineer"),
    );
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(["job_descriptions", "next_cursor"]);
    expect(body.job_descriptions[0]).not.toHaveProperty("search_vector");
  });

  it("returns 500 (not a crash) when searchJobDescriptions throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockSearchJobDescriptions.mockRejectedValue(new Error("db down"));

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?q=engineer"),
    );
    expect(res.status).toBe(500);
  });

  it("returns 401 when unauthenticated, before calling searchJobDescriptions", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await GET(
      makeRequest("http://localhost/api/job-descriptions?q=engineer"),
    );

    expect(res.status).toBe(401);
    expect(mockSearchJobDescriptions).not.toHaveBeenCalled();
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
    expect(mockCreateJobListing).not.toHaveBeenCalled();
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
    expect(mockCreateJobListing).not.toHaveBeenCalled();
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
    expect(mockCreateJobListing).not.toHaveBeenCalled();
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

  it("creates the listing through the RPC, never passing a client-supplied submitted_by (the RPC uses auth.uid())", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockCreateJobListing.mockResolvedValue(row);

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
    expect(mockCreateJobListing).toHaveBeenCalledTimes(1);
    const args = mockCreateJobListing.mock.calls[0][1];
    expect(args).not.toHaveProperty("submittedBy");
    expect(args).not.toHaveProperty("submitted_by");
    expect(args).toMatchObject({ title: "Software Engineer", company: "Acme", visibility: "shared" });
  });

  it("returns 500 (not a crash) when the query layer throws", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockCreateJobListing.mockRejectedValue(new Error("db down"));

    const res = await POST(
      makeRequest("http://localhost/api/job-descriptions", {
        method: "POST",
        body: JSON.stringify({ title: "t", description: "d" }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("passes location and level through to the query layer when provided", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockCreateJobListing.mockResolvedValue(row);

    await POST(
      makeRequest("http://localhost/api/job-descriptions", {
        method: "POST",
        body: JSON.stringify({
          title: "Software Engineer",
          description: "Build things.",
          location: "Remote",
          level: "Entry Level",
        }),
      }),
    );

    expect(mockCreateJobListing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ location: "Remote", level: "Entry Level" }),
    );
  });

  it("returns 400 for a level outside the fixed set", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await POST(
      makeRequest("http://localhost/api/job-descriptions", {
        method: "POST",
        body: JSON.stringify({
          title: "t",
          description: "d",
          level: "Staff",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(mockCreateJobListing).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// M1.5 (docs/ARCHITECTURE.md §13.13.4): scopes, visibility, RPC errors, v2 fields
// ---------------------------------------------------------------------------

const { JobListingRpcError } = await import("@/lib/supabase/queries/jobDescriptions");

function rpcError(message: string, code = "P0001") {
  return new JobListingRpcError("create_job_listing", { code, message });
}

function post(body: unknown) {
  return POST(
    makeRequest("http://localhost/api/job-descriptions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

describe("GET /api/job-descriptions ?scope=", () => {
  beforeEach(() => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockListJobDescriptions.mockResolvedValue({ items: [], hasMore: false });
    mockSearchJobDescriptions.mockResolvedValue({ items: [], hasMore: false });
  });

  it("defaults to scope 'shared'", async () => {
    await GET(makeRequest("http://localhost/api/job-descriptions"));
    expect(mockListJobDescriptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "shared" }),
    );
  });

  it("passes scope=mine with the session user's id (never a request param) to the keyset listing", async () => {
    await GET(makeRequest("http://localhost/api/job-descriptions?scope=mine&callerId=attacker&level=Internship"));
    expect(mockListJobDescriptions).toHaveBeenCalledWith(expect.anything(), {
      limit: 20,
      cursor: null,
      level: "Internship",
      scope: "mine",
      callerId: "user-1",
    });
  });

  it("passes scope=mine to search when q is present", async () => {
    await GET(makeRequest("http://localhost/api/job-descriptions?scope=mine&q=data"));
    expect(mockSearchJobDescriptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "mine", query: "data" }),
    );
    expect(mockListJobDescriptions).not.toHaveBeenCalled();
  });

  it("treats an empty scope as the default", async () => {
    await GET(makeRequest("http://localhost/api/job-descriptions?scope="));
    expect(mockListJobDescriptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "shared" }),
    );
  });

  it.each(["all", "private", "SHARED", "mine "])("returns 400 validation_failed for scope=%j", async (scope) => {
    const res = await GET(makeRequest(`http://localhost/api/job-descriptions?scope=${encodeURIComponent(scope)}`));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_failed");
    expect(mockListJobDescriptions).not.toHaveBeenCalled();
    expect(mockSearchJobDescriptions).not.toHaveBeenCalled();
  });

  it("returns the v2 listing fields and never exposes submitted_by / owner_user_id / internal columns", async () => {
    mockListJobDescriptions.mockResolvedValue({
      items: [
        {
          ...row,
          source: "themuse",
          submitted_by: null,
          apply_url: "https://apply.example.com/1",
          employment_type: "Full-time",
          remote_type: "remote",
          closed_at: "2026-02-01T00:00:00.000Z",
          closed_reason: "expired",
        },
      ],
      hasMore: false,
    });

    const res = await GET(makeRequest("http://localhost/api/job-descriptions"));
    const [item] = (await res.json()).job_descriptions;

    expect(item).toMatchObject({
      visibility: "shared",
      is_closed: true,
      closed_reason: "expired",
      expires_at: "2026-03-02T00:00:00.000Z",
      apply_url: "https://apply.example.com/1",
      employment_type: "Full-time",
      remote_type: "remote",
      source_display_name: "The Muse",
      attribution: { text: "Listing from The Muse", url: "https://www.themuse.com" },
      is_own: false,
    });
    for (const key of ["submitted_by", "owner_user_id", "dedupe_key", "duplicate_of", "content_hash", "external_id", "search_vector", "source_metadata", "last_seen_at"]) {
      expect(item).not.toHaveProperty(key);
    }
  });

  it("user-submitted listings carry no attribution", async () => {
    mockListJobDescriptions.mockResolvedValue({ items: [row], hasMore: false });
    const res = await GET(makeRequest("http://localhost/api/job-descriptions"));
    const [item] = (await res.json()).job_descriptions;
    expect(item.attribution).toBeNull();
    expect(item.is_closed).toBe(false);
    expect(item.is_own).toBe(true);
  });
});

describe("POST /api/job-descriptions (create_job_listing RPC)", () => {
  beforeEach(() => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockCreateJobListing.mockResolvedValue(row);
  });

  it("defaults visibility to 'shared' when omitted (M1.5–M4.2)", async () => {
    const res = await post({ title: "t", description: "d" });
    expect(res.status).toBe(201);
    expect(mockCreateJobListing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ visibility: "shared" }));
  });

  it("passes an explicit 'private' visibility through", async () => {
    mockCreateJobListing.mockResolvedValue({ ...row, visibility: "private", owner_user_id: "user-1", expires_at: null });
    const res = await post({ title: "t", description: "d", visibility: "private" });
    expect(res.status).toBe(201);
    expect(mockCreateJobListing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ visibility: "private" }));
    expect((await res.json()).job_description.visibility).toBe("private");
  });

  it("returns 400 for an unknown visibility without calling the RPC", async () => {
    const res = await post({ title: "t", description: "d", visibility: "public" });
    expect(res.status).toBe(400);
    expect(mockCreateJobListing).not.toHaveBeenCalled();
  });

  it("maps rate_limited:job_listing_create to 429 with kind and retry_after (next UTC midnight)", async () => {
    mockCreateJobListing.mockRejectedValue(rpcError("rate_limited:job_listing_create"));
    const res = await post({ title: "t", description: "d" });
    const body = await res.json();
    expect(res.status).toBe(429);
    expect(body).toMatchObject({ code: "rate_limited", kind: "job_listing_create" });
    expect(body.retry_after).toMatch(/T00:00:00\.000Z$/);
    expect(Date.parse(body.retry_after)).toBeGreaterThan(Date.now());
  });

  it("maps a validation_* RPC error to 400 validation_failed", async () => {
    mockCreateJobListing.mockRejectedValue(rpcError("validation_source_url"));
    const res = await post({ title: "t", description: "d" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_failed");
  });

  it("maps the RPC's unauthenticated (42501) to 401", async () => {
    mockCreateJobListing.mockRejectedValue(rpcError("unauthenticated", "42501"));
    const res = await post({ title: "t", description: "d" });
    expect(res.status).toBe(401);
  });

  it("maps any other RPC error to 500 with the generic copy", async () => {
    mockCreateJobListing.mockRejectedValue(rpcError("something unexpected", "XX000"));
    const res = await post({ title: "t", description: "d" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to save job description.");
  });
});
