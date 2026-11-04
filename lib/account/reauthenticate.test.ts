import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateClient, mockSignIn, mockSignOut } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockSignIn: vi.fn(),
  mockSignOut: vi.fn(),
}));

vi.mock("@supabase/supabase-js", async () => {
  const actual = await vi.importActual<typeof import("@supabase/supabase-js")>(
    "@supabase/supabase-js",
  );
  return { ...actual, createClient: mockCreateClient };
});

const { AuthApiError, AuthRetryableFetchError } = await import(
  "@supabase/supabase-js"
);
const { verifyPassword, createReauthClient } = await import(
  "@/lib/account/reauthenticate"
);

const USER_ID = "11111111-1111-4111-8111-111111111111";
const EMAIL = "student@example.test";
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockCreateClient.mockReturnValue({
    auth: { signInWithPassword: mockSignIn, signOut: mockSignOut },
  });
  mockSignOut.mockResolvedValue({ error: null });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("createReauthClient — throwaway, non-cookie client", () => {
  it("uses the anon key with session persistence and refresh disabled", () => {
    createReauthClient();

    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-key",
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
  });

  it("throws when the Supabase env vars are missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(() => createReauthClient()).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });
});

describe("verifyPassword", () => {
  it("returns ok for correct credentials and revokes the throwaway session (scope local only)", async () => {
    mockSignIn.mockResolvedValue({
      data: { user: { id: USER_ID }, session: {} },
      error: null,
    });

    const outcome = await verifyPassword({
      userId: USER_ID,
      email: EMAIL,
      password: "correct horse",
    });

    expect(outcome).toBe("ok");
    expect(mockSignIn).toHaveBeenCalledWith({
      email: EMAIL,
      password: "correct horse",
    });
    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("still returns ok if revoking the throwaway session fails", async () => {
    mockSignIn.mockResolvedValue({
      data: { user: { id: USER_ID }, session: {} },
      error: null,
    });
    mockSignOut.mockRejectedValue(new Error("network"));

    await expect(
      verifyPassword({ userId: USER_ID, email: EMAIL, password: "pw" }),
    ).resolves.toBe("ok");
  });

  it("returns invalid for rejected credentials (400 invalid_credentials)", async () => {
    mockSignIn.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthApiError(
        "Invalid login credentials",
        400,
        "invalid_credentials",
      ),
    });

    await expect(
      verifyPassword({ userId: USER_ID, email: EMAIL, password: "wrong" }),
    ).resolves.toBe("invalid");
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it.each([
    ["Auth rate limit (429)", new AuthApiError("Too many", 429, "over_request_rate_limit")],
    ["Auth server error (500)", new AuthApiError("boom", 500, undefined)],
    ["network failure", new AuthRetryableFetchError("fetch failed", 0)],
  ])(
    "returns unavailable (not 'wrong password') on %s",
    async (_label, error) => {
      mockSignIn.mockResolvedValue({
        data: { user: null, session: null },
        error,
      });

      await expect(
        verifyPassword({ userId: USER_ID, email: EMAIL, password: "pw" }),
      ).resolves.toBe("unavailable");
    },
  );

  it("returns unavailable if signInWithPassword throws", async () => {
    mockSignIn.mockRejectedValue(new Error("socket hang up"));

    await expect(
      verifyPassword({ userId: USER_ID, email: EMAIL, password: "pw" }),
    ).resolves.toBe("unavailable");
  });

  it("returns invalid if Auth signs in a different user than the session's", async () => {
    mockSignIn.mockResolvedValue({
      data: { user: { id: "someone-else" }, session: {} },
      error: null,
    });

    await expect(
      verifyPassword({ userId: USER_ID, email: EMAIL, password: "pw" }),
    ).resolves.toBe("invalid");
  });

  it.each([undefined, null, ""])(
    "returns invalid without calling Auth when the session user has no email (%s)",
    async (email) => {
      await expect(
        verifyPassword({ userId: USER_ID, email, password: "pw" }),
      ).resolves.toBe("invalid");
      expect(mockCreateClient).not.toHaveBeenCalled();
    },
  );
});
