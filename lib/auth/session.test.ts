import { beforeEach, describe, expect, it, vi } from "vitest";

// `lib/supabase/server.ts`'s `createClient()` is mocked so we can drive
// `auth.getUser()` / `auth.getSession()` without a real Supabase project.
const { mockGetUser, mockGetSession, mockCreateClient } = vi.hoisted(() => {
  return {
    mockGetUser: vi.fn(),
    mockGetSession: vi.fn(),
    mockCreateClient: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateClient,
}));

const { getSession, requireSession, UnauthorizedError } = await import(
  "@/lib/auth/session"
);

const fakeUser = { id: "user-1", email: "user@example.com" } as const;
const fakeSession = { access_token: "token", refresh_token: "refresh" } as const;

beforeEach(() => {
  mockGetUser.mockReset();
  mockGetSession.mockReset();
  mockCreateClient.mockReset();
  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: mockGetUser,
      getSession: mockGetSession,
    },
  });
});

describe("getSession()", () => {
  it("returns null when there is no user (no session)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const result = await getSession();

    expect(result).toBeNull();
    // getSession() short-circuits before calling auth.getSession() again.
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("returns null on a soft auth error from getUser()", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "invalid JWT", status: 401 },
    });

    const result = await getSession();

    expect(result).toBeNull();
  });

  it("returns null if getUser() succeeds but getSession() reports an error", async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: { message: "session expired" },
    });

    const result = await getSession();

    expect(result).toBeNull();
  });

  it("returns null if getUser() succeeds but getSession() has no session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const result = await getSession();

    expect(result).toBeNull();
  });

  it("returns { user, session } on success", async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    mockGetSession.mockResolvedValue({
      data: { session: fakeSession },
      error: null,
    });

    const result = await getSession();

    expect(result).toEqual({ user: fakeUser, session: fakeSession });
  });
});

describe("requireSession()", () => {
  it("throws UnauthorizedError with status 401 when there is no session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(requireSession()).rejects.toThrow(UnauthorizedError);

    // Re-run to inspect the thrown instance's `.status` without relying on
    // a stale mock/response state.
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    try {
      await requireSession();
      expect.unreachable("requireSession() should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect((err as InstanceType<typeof UnauthorizedError>).status).toBe(
        401,
      );
    }
  });

  it("resolves with the session on success", async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    mockGetSession.mockResolvedValue({
      data: { session: fakeSession },
      error: null,
    });

    const result = await requireSession();

    expect(result).toEqual({ user: fakeUser, session: fakeSession });
  });
});
