import { beforeEach, describe, expect, it, vi } from "vitest";

/** QA: GET /api/job-descriptions/facets (§7.8.6). Uses the real query function over a mocked RPC. */
const { mockRequireSession, mockCreateClient } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockCreateClient: vi.fn(),
}));

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return { ...actual, requireSession: mockRequireSession };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: mockCreateClient }));

const { GET } = await import("@/app/api/job-descriptions/facets/route");
const { UnauthorizedError } = await import("@/lib/auth/session");

function rpcReturning(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  mockCreateClient.mockResolvedValue({ rpc });
  return rpc;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/job-descriptions/facets", () => {
  it("returns 401 when signed out, without calling the RPC", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const rpc = rpcReturning({ data: [], error: null });

    const res = await GET();

    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("returns counts with a private cache header, dropping zero and garbage counts", async () => {
    mockRequireSession.mockResolvedValue({ user: { id: "u1" } });
    const rpc = rpcReturning({
      data: [
        { facet: "category", value: "software", listing_count: 118 },
        { facet: "category", value: "data", listing_count: 0 },
        { facet: "state", value: "CA", listing_count: "42" },
        { facet: "state", value: "NY", listing_count: null },
        { facet: "remote", value: "true", listing_count: 9 },
        { facet: "mystery", value: "x", listing_count: 3 },
      ],
      error: null,
    });

    const res = await GET();
    const body = await res.json();

    expect(rpc).toHaveBeenCalledWith("job_description_facets");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(body).toEqual({ categories: { software: 118 }, states: { CA: 42 }, remote: 9 });
  });

  it("returns remote: 0 and empty maps for an empty board", async () => {
    mockRequireSession.mockResolvedValue({ user: { id: "u1" } });
    rpcReturning({ data: [], error: null });

    const body = await (await GET()).json();

    expect(body).toEqual({ categories: {}, states: {}, remote: 0 });
  });

  it("returns 500 with a generic message when the RPC fails (e.g. 0012 not applied)", async () => {
    mockRequireSession.mockResolvedValue({ user: { id: "u1" } });
    rpcReturning({ data: null, error: { message: "function job_description_facets() does not exist" } });

    const res = await GET();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load job filters." });
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});
