import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireSession,
  mockCreateClient,
  mockGetJobDescriptionById,
  mockUpdateJobListing,
  mockDeleteJobListing,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
  mockGetJobDescriptionById: vi.fn(),
  mockUpdateJobListing: vi.fn(),
  mockDeleteJobListing: vi.fn(),
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
    updateJobListing: mockUpdateJobListing,
    deleteJobListing: mockDeleteJobListing,
  };
});

const { GET, PATCH, DELETE } = await import("@/app/api/job-descriptions/[id]/route");
const { JobListingRpcError } = await import("@/lib/supabase/queries/jobDescriptions");
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

/** The caller's own `source='user'` row — the only shape PATCH/DELETE may act on. */
const ownRow = {
  id: "jd-1",
  submitted_by: "user-1",
  title: "Software Engineer",
  company: "Acme",
  description: "Build things.",
  source_url: null,
  location: null,
  level: null,
  posted_at: null,
  created_at: "t",
  updated_at: "t",
  source: "user",
  deleted_at: null,
};

/** Another user's own `source='user'` row — PATCH/DELETE must 403, never leak via 404. */
const otherUsersOwnRow = { ...ownRow, submitted_by: "someone-else" };

/** A themuse-sourced row: submitted_by is always null (per docs/ARCHITECTURE.md §10.1). */
const themuseRow = { ...ownRow, submitted_by: null, source: "themuse" };

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(body: unknown) {
  return new Request("http://x", { method: "PATCH", body: JSON.stringify(body) });
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

describe("PATCH /api/job-descriptions/:id — edit own, per docs/ARCHITECTURE.md §10.3", () => {
  it("returns 401 when unauthenticated, before touching the DB", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await PATCH(patchRequest({ title: "New Title" }), ctx("jd-1"));
    expect(res.status).toBe(401);
    expect(mockGetJobDescriptionById).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-JSON body", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: "not json" }),
      ctx("jd-1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an empty body — at least one field must be present", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });

    const res = await PATCH(patchRequest({}), ctx("jd-1"));
    expect(res.status).toBe(400);
    expect(mockGetJobDescriptionById).not.toHaveBeenCalled();
    expect(mockUpdateJobListing).not.toHaveBeenCalled();
  });

  it("returns 404 when the row doesn't exist at all (checked before the ownership gate)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(null);

    const res = await PATCH(patchRequest({ title: "New Title" }), ctx("missing-id"));
    expect(res.status).toBe(404);
    expect(mockUpdateJobListing).not.toHaveBeenCalled();
  });

  // Privacy-boundary check: existence of shared job-description data is
  // already public via GET (per docs/ARCHITECTURE.md §2's intro), so a
  // crafted PATCH against another real user's own row must come back 403,
  // not 404 — 404 here would incorrectly suggest the row doesn't exist.
  it("returns 403 (not 404) for a crafted PATCH against another user's own source='user' row", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(otherUsersOwnRow);

    const res = await PATCH(patchRequest({ title: "Hijacked title" }), ctx("jd-1"));

    expect(res.status).toBe(403);
    expect(mockUpdateJobListing).not.toHaveBeenCalled();
  });

  // The app-level check must not simply trust RLS to silently no-op: even
  // though `submitted_by` is null for every themuse row (so RLS's
  // `submitted_by = auth.uid()` could never match), this asserts the route's
  // OWN ownership check (`existing.submitted_by !== user.id || existing.source
  // !== "user"`) actually short-circuits before ever calling the query layer,
  // for a themuse row the caller happens to know the id of.
  it("returns 403 for a themuse-sourced row even from a fully authenticated user (submitted_by is always null for these — app-level check must not rely on RLS alone)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(themuseRow);

    const res = await PATCH(patchRequest({ title: "Hijacked title" }), ctx("jd-1"));

    expect(res.status).toBe(403);
    expect(mockUpdateJobListing).not.toHaveBeenCalled();
  });

  it("returns 403 if update_job_listing raises not_found_or_not_owner (defense-in-depth — e.g. a race where the row changed between the pre-check and the write)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockUpdateJobListing.mockRejectedValue(
      new JobListingRpcError("update_job_listing", { code: "P0001", message: "not_found_or_not_owner" }),
    );

    const res = await PATCH(patchRequest({ title: "New Title" }), ctx("jd-1"));
    expect(res.status).toBe(403);
  });

  it("updates the caller's own row and returns 200 with the updated shape", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockUpdateJobListing.mockResolvedValue({ ...ownRow, title: "New Title" });

    const res = await PATCH(patchRequest({ title: "New Title" }), ctx("jd-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.job_description.title).toBe("New Title");
    expect(mockUpdateJobListing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "jd-1" }),
    );
    // The RPC resolves the caller from auth.uid(); no owner is passed in.
    expect(mockUpdateJobListing.mock.calls[0][1]).not.toHaveProperty("submittedBy");
  });

  // The three-way clearableOptional() distinction, exercised end-to-end
  // through the route (schema -> route -> query-layer patch argument), not
  // just at the schema layer in isolation.
  describe("clearableOptional() three-way distinction (omitted / explicit clear / explicit value)", () => {
    it("an omitted key leaves the field untouched (undefined reaches updateJobListing's patch, so it's left out of p_patch)", async () => {
      mockRequireSession.mockResolvedValue({ user: fakeUser });
      mockGetJobDescriptionById.mockResolvedValue(ownRow);
      mockUpdateJobListing.mockResolvedValue(ownRow);

      // location/level/company/source_url are all omitted — only title is present.
      await PATCH(patchRequest({ title: "New Title" }), ctx("jd-1"));

      const patchArg = mockUpdateJobListing.mock.calls[0][1].patch;
      expect(patchArg.title).toBe("New Title");
      expect(patchArg.company).toBeUndefined();
      expect(patchArg.location).toBeUndefined();
      expect(patchArg.level).toBeUndefined();
      expect(patchArg.sourceUrl).toBeUndefined();
    });

    it("an explicit empty string clears company/location to null", async () => {
      mockRequireSession.mockResolvedValue({ user: fakeUser });
      mockGetJobDescriptionById.mockResolvedValue(ownRow);
      mockUpdateJobListing.mockResolvedValue({ ...ownRow, company: null, location: null });

      await PATCH(patchRequest({ company: "", location: "   " }), ctx("jd-1"));

      const patchArg = mockUpdateJobListing.mock.calls[0][1].patch;
      expect(patchArg.company).toBeNull();
      expect(patchArg.location).toBeNull();
    });

    it("an explicit JSON null clears company to null (same as an explicit empty string)", async () => {
      mockRequireSession.mockResolvedValue({ user: fakeUser });
      mockGetJobDescriptionById.mockResolvedValue(ownRow);
      mockUpdateJobListing.mockResolvedValue({ ...ownRow, company: null });

      await PATCH(patchRequest({ company: null }), ctx("jd-1"));

      const patchArg = mockUpdateJobListing.mock.calls[0][1].patch;
      expect(patchArg.company).toBeNull();
    });

    it("an explicit non-empty value updates the field normally", async () => {
      mockRequireSession.mockResolvedValue({ user: fakeUser });
      mockGetJobDescriptionById.mockResolvedValue(ownRow);
      mockUpdateJobListing.mockResolvedValue({ ...ownRow, company: "New Co" });

      await PATCH(patchRequest({ company: "New Co" }), ctx("jd-1"));

      const patchArg = mockUpdateJobListing.mock.calls[0][1].patch;
      expect(patchArg.company).toBe("New Co");
    });

    it("title stays a plain optional (not clearable) — an empty string fails validation instead of clearing a not-null column", async () => {
      mockRequireSession.mockResolvedValue({ user: fakeUser });
      mockGetJobDescriptionById.mockResolvedValue(ownRow);

      const res = await PATCH(patchRequest({ title: "" }), ctx("jd-1"));
      expect(res.status).toBe(400);
      expect(mockUpdateJobListing).not.toHaveBeenCalled();
    });
  });

  it("returns 500 (not a crash) when the query layer throws unexpectedly", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockUpdateJobListing.mockRejectedValue(new Error("db down"));

    const res = await PATCH(patchRequest({ title: "New Title" }), ctx("jd-1"));
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/job-descriptions/:id — soft-delete own, per docs/ARCHITECTURE.md §10.3", () => {
  it("returns 401 when unauthenticated, before touching the DB", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));
    expect(res.status).toBe(401);
    expect(mockGetJobDescriptionById).not.toHaveBeenCalled();
  });

  it("returns 404 when the row doesn't exist at all", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(null);

    const res = await DELETE(new Request("http://x"), ctx("missing-id"));
    expect(res.status).toBe(404);
    expect(mockDeleteJobListing).not.toHaveBeenCalled();
  });

  // Privacy-boundary check: a crafted DELETE against another real user's own
  // row must 403, not silently succeed and not 404 (existence is public).
  it("returns 403 (not 404, and does not delete) for a crafted DELETE against another user's own source='user' row", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(otherUsersOwnRow);

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));

    expect(res.status).toBe(403);
    expect(mockDeleteJobListing).not.toHaveBeenCalled();
  });

  // Same "app-level check must not rely on RLS alone" concern as PATCH above:
  // a themuse row's submitted_by is always null, but the route's own
  // ownership check must still be the thing that blocks this, verified by
  // asserting the query layer is never even called.
  it("returns 403 for a themuse-sourced row even from a fully authenticated user", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(themuseRow);

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));

    expect(res.status).toBe(403);
    expect(mockDeleteJobListing).not.toHaveBeenCalled();
  });

  it("returns 403 if delete_job_listing raises not_found_or_not_owner (defense-in-depth)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockDeleteJobListing.mockRejectedValue(
      new JobListingRpcError("delete_job_listing", { code: "P0001", message: "not_found_or_not_owner" }),
    );

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));
    expect(res.status).toBe(403);
  });

  it("soft-deletes the caller's own row and returns 204 with an empty body", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockDeleteJobListing.mockResolvedValue("soft_deleted");

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));

    expect(res.status).toBe(204);
    expect(mockDeleteJobListing).toHaveBeenCalledWith(expect.anything(), "jd-1");
    const text = await res.text();
    expect(text).toBe("");
  });

  it("is idempotent: deleting an already-deleted row still returns 204", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue({
      ...ownRow,
      deleted_at: "2026-01-01T00:00:00.000Z",
    });
    mockDeleteJobListing.mockResolvedValue("soft_deleted");

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));
    expect(res.status).toBe(204);
  });

  it("returns 500 (not a crash) when the query layer throws unexpectedly", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockDeleteJobListing.mockRejectedValue(new Error("db down"));

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// M1.5 (docs/ARCHITECTURE.md §13.13.4): private listings, visibility, RPC errors
// ---------------------------------------------------------------------------

/** The caller's own private listing. */
const ownPrivateRow = { ...ownRow, visibility: "private", owner_user_id: "user-1", expires_at: null };

function rpcError(message: string, code = "P0001") {
  return new JobListingRpcError("update_job_listing", { code, message });
}

describe("GET /api/job-descriptions/:id — v2", () => {
  it("returns 404 for another user's private listing (RLS returns no row)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(null);
    const res = await GET(new Request("http://x"), ctx("someone-elses-private"));
    expect(res.status).toBe(404);
  });

  it("still resolves a closed (expired) listing by id, flagged is_closed", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue({ ...themuseRow, closed_at: "2026-02-01T00:00:00.000Z", closed_reason: "expired" });
    const res = await GET(new Request("http://x"), ctx("jd-1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.job_description).toMatchObject({ is_closed: true, closed_reason: "expired", source_display_name: "The Muse" });
  });

  it("returns the caller's own private listing with visibility 'private' and no owner id", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownPrivateRow);
    const res = await GET(new Request("http://x"), ctx("jd-1"));
    const body = await res.json();
    expect(body.job_description.visibility).toBe("private");
    expect(body.job_description).not.toHaveProperty("owner_user_id");
  });
});

describe("PATCH /api/job-descriptions/:id — v2", () => {
  beforeEach(() => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
  });

  it("returns 404 (not 403) for another user's private listing: RLS hides it, so the pre-check finds nothing", async () => {
    mockGetJobDescriptionById.mockResolvedValue(null);
    const res = await PATCH(patchRequest({ visibility: "shared" }), ctx("someone-elses-private"));
    expect(res.status).toBe(404);
    expect(mockUpdateJobListing).not.toHaveBeenCalled();
  });

  it("private -> shared passes visibility through and returns the shared row", async () => {
    mockGetJobDescriptionById.mockResolvedValue(ownPrivateRow);
    mockUpdateJobListing.mockResolvedValue({ ...ownRow, visibility: "shared", owner_user_id: null });
    const res = await PATCH(patchRequest({ visibility: "shared" }), ctx("jd-1"));
    expect(res.status).toBe(200);
    expect(mockUpdateJobListing.mock.calls[0][1].patch).toEqual({
      title: undefined,
      company: undefined,
      description: undefined,
      sourceUrl: undefined,
      location: undefined,
      level: undefined,
      visibility: "shared",
    });
    expect((await res.json()).job_description.visibility).toBe("shared");
  });

  it("maps visibility_downgrade (shared -> private) to 400 with that code", async () => {
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockUpdateJobListing.mockRejectedValue(rpcError("visibility_downgrade"));
    const res = await PATCH(patchRequest({ visibility: "private" }), ctx("jd-1"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("visibility_downgrade");
  });

  it("returns 400 for an unknown visibility without calling the RPC", async () => {
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    const res = await PATCH(patchRequest({ visibility: "public" }), ctx("jd-1"));
    expect(res.status).toBe(400);
    expect(mockUpdateJobListing).not.toHaveBeenCalled();
  });

  it("maps rate_limited:job_listing_update to 429 with kind job_listing_update", async () => {
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockUpdateJobListing.mockRejectedValue(rpcError("rate_limited:job_listing_update"));
    const res = await PATCH(patchRequest({ description: "changed" }), ctx("jd-1"));
    const body = await res.json();
    expect(res.status).toBe(429);
    expect(body).toMatchObject({ code: "rate_limited", kind: "job_listing_update" });
    expect(typeof body.retry_after).toBe("string");
  });

  it("maps the RPC's unauthenticated (42501) to 401", async () => {
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockUpdateJobListing.mockRejectedValue(rpcError("unauthenticated", "42501"));
    const res = await PATCH(patchRequest({ title: "x" }), ctx("jd-1"));
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/job-descriptions/:id — v2", () => {
  beforeEach(() => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
  });

  it("hard-deletes the caller's own private listing and returns 204", async () => {
    mockGetJobDescriptionById.mockResolvedValue(ownPrivateRow);
    mockDeleteJobListing.mockResolvedValue("deleted");
    const res = await DELETE(new Request("http://x"), ctx("jd-1"));
    expect(res.status).toBe(204);
    expect(mockDeleteJobListing).toHaveBeenCalledWith(expect.anything(), "jd-1");
  });

  it("returns 404 for another user's private listing (hidden by RLS) without calling the RPC", async () => {
    mockGetJobDescriptionById.mockResolvedValue(null);
    const res = await DELETE(new Request("http://x"), ctx("someone-elses-private"));
    expect(res.status).toBe(404);
    expect(mockDeleteJobListing).not.toHaveBeenCalled();
  });

  it("returns 500 for an unexpected RPC error", async () => {
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockDeleteJobListing.mockRejectedValue(new JobListingRpcError("delete_job_listing", { code: "XX000", message: "boom" }));
    const res = await DELETE(new Request("http://x"), ctx("jd-1"));
    expect(res.status).toBe(500);
  });
});
