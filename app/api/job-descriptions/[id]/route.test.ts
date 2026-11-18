import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireSession,
  mockCreateClient,
  mockGetJobDescriptionById,
  mockUpdateJobDescription,
  mockSoftDeleteJobDescription,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
  mockGetJobDescriptionById: vi.fn(),
  mockUpdateJobDescription: vi.fn(),
  mockSoftDeleteJobDescription: vi.fn(),
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
    updateJobDescription: mockUpdateJobDescription,
    softDeleteJobDescription: mockSoftDeleteJobDescription,
  };
});

const { GET, PATCH, DELETE } = await import("@/app/api/job-descriptions/[id]/route");
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
    expect(mockUpdateJobDescription).not.toHaveBeenCalled();
  });

  it("returns 404 when the row doesn't exist at all (checked before the ownership gate)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(null);

    const res = await PATCH(patchRequest({ title: "New Title" }), ctx("missing-id"));
    expect(res.status).toBe(404);
    expect(mockUpdateJobDescription).not.toHaveBeenCalled();
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
    expect(mockUpdateJobDescription).not.toHaveBeenCalled();
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
    expect(mockUpdateJobDescription).not.toHaveBeenCalled();
  });

  it("returns 403 if updateJobDescription itself returns null (defense-in-depth — e.g. a race where the row changed between the pre-check and the write)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockUpdateJobDescription.mockResolvedValue(null);

    const res = await PATCH(patchRequest({ title: "New Title" }), ctx("jd-1"));
    expect(res.status).toBe(403);
  });

  it("updates the caller's own row and returns 200 with the updated shape", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockUpdateJobDescription.mockResolvedValue({ ...ownRow, title: "New Title" });

    const res = await PATCH(patchRequest({ title: "New Title" }), ctx("jd-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.job_description.title).toBe("New Title");
    expect(mockUpdateJobDescription).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "jd-1", submittedBy: "user-1" }),
    );
  });

  // The three-way clearableOptional() distinction, exercised end-to-end
  // through the route (schema -> route -> query-layer patch argument), not
  // just at the schema layer in isolation.
  describe("clearableOptional() three-way distinction (omitted / explicit clear / explicit value)", () => {
    it("an omitted key leaves the field untouched (undefined reaches updateJobDescription's patch, not written)", async () => {
      mockRequireSession.mockResolvedValue({ user: fakeUser });
      mockGetJobDescriptionById.mockResolvedValue(ownRow);
      mockUpdateJobDescription.mockResolvedValue(ownRow);

      // location/level/company/source_url are all omitted — only title is present.
      await PATCH(patchRequest({ title: "New Title" }), ctx("jd-1"));

      const patchArg = mockUpdateJobDescription.mock.calls[0][1].patch;
      expect(patchArg.title).toBe("New Title");
      expect(patchArg.company).toBeUndefined();
      expect(patchArg.location).toBeUndefined();
      expect(patchArg.level).toBeUndefined();
      expect(patchArg.sourceUrl).toBeUndefined();
    });

    it("an explicit empty string clears company/location to null", async () => {
      mockRequireSession.mockResolvedValue({ user: fakeUser });
      mockGetJobDescriptionById.mockResolvedValue(ownRow);
      mockUpdateJobDescription.mockResolvedValue({ ...ownRow, company: null, location: null });

      await PATCH(patchRequest({ company: "", location: "   " }), ctx("jd-1"));

      const patchArg = mockUpdateJobDescription.mock.calls[0][1].patch;
      expect(patchArg.company).toBeNull();
      expect(patchArg.location).toBeNull();
    });

    it("an explicit JSON null clears company to null (same as an explicit empty string)", async () => {
      mockRequireSession.mockResolvedValue({ user: fakeUser });
      mockGetJobDescriptionById.mockResolvedValue(ownRow);
      mockUpdateJobDescription.mockResolvedValue({ ...ownRow, company: null });

      await PATCH(patchRequest({ company: null }), ctx("jd-1"));

      const patchArg = mockUpdateJobDescription.mock.calls[0][1].patch;
      expect(patchArg.company).toBeNull();
    });

    it("an explicit non-empty value updates the field normally", async () => {
      mockRequireSession.mockResolvedValue({ user: fakeUser });
      mockGetJobDescriptionById.mockResolvedValue(ownRow);
      mockUpdateJobDescription.mockResolvedValue({ ...ownRow, company: "New Co" });

      await PATCH(patchRequest({ company: "New Co" }), ctx("jd-1"));

      const patchArg = mockUpdateJobDescription.mock.calls[0][1].patch;
      expect(patchArg.company).toBe("New Co");
    });

    it("title stays a plain optional (not clearable) — an empty string fails validation instead of clearing a not-null column", async () => {
      mockRequireSession.mockResolvedValue({ user: fakeUser });
      mockGetJobDescriptionById.mockResolvedValue(ownRow);

      const res = await PATCH(patchRequest({ title: "" }), ctx("jd-1"));
      expect(res.status).toBe(400);
      expect(mockUpdateJobDescription).not.toHaveBeenCalled();
    });
  });

  it("returns 500 (not a crash) when the query layer throws unexpectedly", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockUpdateJobDescription.mockRejectedValue(new Error("db down"));

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
    expect(mockSoftDeleteJobDescription).not.toHaveBeenCalled();
  });

  // Privacy-boundary check: a crafted DELETE against another real user's own
  // row must 403, not silently succeed and not 404 (existence is public).
  it("returns 403 (not 404, and does not delete) for a crafted DELETE against another user's own source='user' row", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(otherUsersOwnRow);

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));

    expect(res.status).toBe(403);
    expect(mockSoftDeleteJobDescription).not.toHaveBeenCalled();
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
    expect(mockSoftDeleteJobDescription).not.toHaveBeenCalled();
  });

  it("returns 403 if softDeleteJobDescription itself returns false (defense-in-depth)", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockSoftDeleteJobDescription.mockResolvedValue(false);

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));
    expect(res.status).toBe(403);
  });

  it("soft-deletes the caller's own row and returns 204 with an empty body", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockSoftDeleteJobDescription.mockResolvedValue(true);

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));

    expect(res.status).toBe(204);
    expect(mockSoftDeleteJobDescription).toHaveBeenCalledWith(
      expect.anything(),
      { id: "jd-1", submittedBy: "user-1" },
    );
    const text = await res.text();
    expect(text).toBe("");
  });

  it("is idempotent: deleting an already-deleted row still returns 204", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue({
      ...ownRow,
      deleted_at: "2026-01-01T00:00:00.000Z",
    });
    mockSoftDeleteJobDescription.mockResolvedValue(true);

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));
    expect(res.status).toBe(204);
  });

  it("returns 500 (not a crash) when the query layer throws unexpectedly", async () => {
    mockRequireSession.mockResolvedValue({ user: fakeUser });
    mockGetJobDescriptionById.mockResolvedValue(ownRow);
    mockSoftDeleteJobDescription.mockRejectedValue(new Error("db down"));

    const res = await DELETE(new Request("http://x"), ctx("jd-1"));
    expect(res.status).toBe(500);
  });
});
