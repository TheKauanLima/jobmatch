import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireSession, mockRpc, mockCreateServerClient } = vi.hoisted(
  () => ({
    mockRequireSession: vi.fn(),
    mockRpc: vi.fn(),
    mockCreateServerClient: vi.fn(),
  }),
);

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>(
    "@/lib/auth/session",
  );
  return { ...actual, requireSession: mockRequireSession };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateServerClient,
}));

const { GET } = await import("@/app/api/account/limits/route");
const { UnauthorizedError } = await import("@/lib/auth/session");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RESETS_AT_DB = "2026-11-10T00:00:00+00:00";
const RESETS_AT = "2026-11-10T00:00:00.000Z";

/** All seven kinds, as `get_my_rate_limits()` returns them (ordered by kind). */
const DB_ROWS = [
  ["account_reauth", 10, 2],
  ["fit_check", 20, 0],
  ["job_listing_create", 20, 1],
  ["job_listing_update", 40, 0],
  ["refresh_matches", 5, 0],
  ["resume_report", 5, 3],
  ["url_import", 20, 0],
].map(([kind, daily_limit, used_today]) => ({
  kind,
  daily_limit,
  used_today,
  resets_at: RESETS_AT_DB,
}));

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireSession.mockResolvedValue({ user: { id: USER_ID } });
  mockRpc.mockResolvedValue({ data: DB_ROWS, error: null });
  mockCreateServerClient.mockResolvedValue({ rpc: mockRpc });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("GET /api/account/limits", () => {
  it("200 with every kind (including account_reauth) in the §13.13.7 shape", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Object.keys(json)).toEqual(["limits"]);
    expect(json.limits).toHaveLength(7);
    expect(json.limits[0]).toEqual({
      kind: "account_reauth",
      daily_limit: 10,
      used_today: 2,
      resets_at: RESETS_AT,
    });
    for (const entry of json.limits) {
      expect(Object.keys(entry).sort()).toEqual(
        ["daily_limit", "kind", "resets_at", "used_today"],
      );
      expect(entry.resets_at).toBe(RESETS_AT);
    }
    expect(json.limits.map((l: { kind: string }) => l.kind)).toContain(
      "account_reauth",
    );
  });

  it("reads through the session client's get_my_rate_limits (no user id passed)", async () => {
    await GET();

    expect(mockCreateServerClient).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("get_my_rate_limits");
  });

  it("is never cacheable", async () => {
    const res = await GET();

    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("401 when signed out, without calling the RPC", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await GET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("401 if the RPC raises unauthenticated (42501: session expired mid-request)", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "unauthenticated" },
    });

    const res = await GET();

    expect(res.status).toBe(401);
  });

  it("500 internal_error on any other RPC error", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "boom" },
    });

    const res = await GET();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: "internal_error",
    });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("500 (not a crash) if the session check throws unexpectedly", async () => {
    mockRequireSession.mockRejectedValue(new Error("auth down"));

    const res = await GET();

    expect(res.status).toBe(500);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("500 if the session client can't be created", async () => {
    mockCreateServerClient.mockRejectedValue(new Error("no cookies"));

    const res = await GET();

    expect(res.status).toBe(500);
  });

  it("200 with an empty list when there are no configured kinds", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ limits: [] });
  });
});
