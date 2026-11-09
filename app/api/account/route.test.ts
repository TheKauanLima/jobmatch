import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireSession,
  mockDeleteAccount,
  mockClearAuthSession,
  mockServerRpc,
  mockCreateServerClient,
  mockSupabaseJsCreateClient,
  mockSignInWithPassword,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockDeleteAccount: vi.fn(),
  mockClearAuthSession: vi.fn(),
  /** `rpc` on the cookie-bound session client (`lib/supabase/server.ts`). */
  mockServerRpc: vi.fn(),
  mockCreateServerClient: vi.fn(),
  /** The plain supabase-js factory the throwaway re-auth client is built with. */
  mockSupabaseJsCreateClient: vi.fn(),
  /** GoTrue password check on that throwaway client. */
  mockSignInWithPassword: vi.fn(),
}));

/**
 * The real `deleteAccount` → `verifyPassword` path builds its throwaway
 * client with supabase-js `createClient`; routing that to a fake lets the
 * re-auth rate-limit tests assert that GoTrue's `signInWithPassword` is
 * (or is not) reached through the real code, not just that a mock wasn't
 * called.
 */
vi.mock("@supabase/supabase-js", async () => {
  const actual = await vi.importActual<typeof import("@supabase/supabase-js")>(
    "@supabase/supabase-js",
  );
  return { ...actual, createClient: mockSupabaseJsCreateClient };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateServerClient,
}));

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>(
    "@/lib/auth/session",
  );
  return { ...actual, requireSession: mockRequireSession };
});

vi.mock("@/lib/account/deleteAccount", () => ({
  deleteAccount: mockDeleteAccount,
}));

vi.mock("@/lib/account/clearAuthSession", () => ({
  clearAuthSession: mockClearAuthSession,
}));

const routeModule = await import("@/app/api/account/route");
const { DELETE } = routeModule;
const { UnauthorizedError } = await import("@/lib/auth/session");
const { AuthApiError } = await import("@supabase/supabase-js");
const { deleteAccount: realDeleteAccount } = await vi.importActual<
  typeof import("@/lib/account/deleteAccount")
>("@/lib/account/deleteAccount");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const EMAIL = "student@example.test";
const PASSWORD = "s3cret-Pa55word";
const fakeUser = { id: USER_ID, email: EMAIL };

function req(body: unknown, raw = false) {
  return new Request("http://localhost/api/account", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireSession.mockResolvedValue({ user: fakeUser });
  mockDeleteAccount.mockResolvedValue({ ok: true });
  mockClearAuthSession.mockResolvedValue(undefined);
  mockServerRpc.mockResolvedValue({ data: true, error: null });
  mockCreateServerClient.mockResolvedValue({ rpc: mockServerRpc });
  // Only reached when a test opts into the real deleteAccount. Wrong
  // password by default, so the real sequence stops right after GoTrue
  // (before any admin client or deletion).
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockSignInWithPassword.mockResolvedValue({
    data: { user: null, session: null },
    error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
  });
  mockSupabaseJsCreateClient.mockReturnValue({
    auth: { signInWithPassword: mockSignInWithPassword, signOut: vi.fn() },
  });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const call of errorSpy.mock.calls) {
    const line = call.map(String).join(" ");
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain(EMAIL);
  }
  errorSpy.mockRestore();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

/** §13.13.7: every 500 from this route carries the same body and copy. */
const INTERNAL_ERROR_COPY =
  "We couldn't finish deleting your account. Your account still exists — please try again.";

async function expectInternalError(res: Response) {
  expect(res.status).toBe(500);
  const json = await res.json();
  expect(json).toEqual({ error: INTERNAL_ERROR_COPY, code: "internal_error" });
  return json;
}

/** Run the real deleteAccount (→ real verifyPassword → fake GoTrue). */
function useRealDeleteAccount() {
  mockDeleteAccount.mockImplementation(realDeleteAccount);
}

describe("DELETE /api/account — route config", () => {
  it("exports maxDuration = 60", () => {
    expect(routeModule.maxDuration).toBe(60);
  });
});

describe("DELETE /api/account — auth", () => {
  it("returns 401 without a session and never attempts deletion", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    expect(res.status).toBe(401);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockClearAuthSession).not.toHaveBeenCalled();
    expect(mockServerRpc).not.toHaveBeenCalled();
  });

  it("returns 500 (not a crash) if the session check throws unexpectedly", async () => {
    mockRequireSession.mockRejectedValue(new Error("auth down"));

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    await expectInternalError(res);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/account — validation (400)", () => {
  it.each([
    ["non-JSON body", "not json", true],
    ["missing confirm", { password: PASSWORD }, false],
    ["lowercase confirm", { password: PASSWORD, confirm: "delete" }, false],
    ["confirm with whitespace", { password: PASSWORD, confirm: " DELETE" }, false],
    ["wrong confirm word", { password: PASSWORD, confirm: "YES" }, false],
    ["missing password", { confirm: "DELETE" }, false],
    ["empty password", { password: "", confirm: "DELETE" }, false],
    ["non-string password", { password: 12345678, confirm: "DELETE" }, false],
    ["oversized password", { password: "x".repeat(1025), confirm: "DELETE" }, false],
    ["array body", [], false],
    ["null body", null, false],
  ])("rejects %s with 400 validation_failed and never deletes", async (_l, body, raw) => {
    const res = await DELETE(req(body, raw));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("validation_failed");
    expect(typeof json.error).toBe("string");
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    // A malformed request doesn't use up a re-auth attempt.
    expect(mockServerRpc).not.toHaveBeenCalled();
    expect(mockClearAuthSession).not.toHaveBeenCalled();
  });

  it("never echoes the password back in a validation error", async () => {
    const res = await DELETE(req({ password: PASSWORD, confirm: "nope" }));

    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(PASSWORD);
  });

  it("does not trim the password (spaces can be part of a real password)", async () => {
    await DELETE(req({ password: "  spaced  ", confirm: "DELETE" }));

    expect(mockDeleteAccount).toHaveBeenCalledWith(
      expect.objectContaining({ password: "  spaced  " }),
    );
  });
});

describe("DELETE /api/account — deletion outcomes", () => {
  it("204 on success, with the session cleared after deletion", async () => {
    const order: string[] = [];
    mockDeleteAccount.mockImplementation(async () => {
      order.push("delete");
      return { ok: true };
    });
    mockClearAuthSession.mockImplementation(async () => {
      order.push("clear");
    });

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(order).toEqual(["delete", "clear"]);
  });

  it("deletes the SESSION user's account — ignores any user id/email smuggled into the body", async () => {
    await DELETE(
      req({
        password: PASSWORD,
        confirm: "DELETE",
        user_id: "22222222-2222-4222-8222-222222222222",
        email: "victim@example.test",
      }),
    );

    expect(mockDeleteAccount).toHaveBeenCalledWith({
      userId: USER_ID,
      email: EMAIL,
      password: PASSWORD,
    });
  });

  it("403 reauth_failed on a wrong password, session left alone", async () => {
    mockDeleteAccount.mockResolvedValue({ ok: false, reason: "reauth_failed" });

    const res = await DELETE(req({ password: "wrong", confirm: "DELETE" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: "reauth_failed",
    });
    expect(mockClearAuthSession).not.toHaveBeenCalled();
  });

  it.each(["reauth", "setup", "cancel_tasks", "storage_purge", "delete_user"] as const)(
    "500 internal_error when step %s fails, session left alone (account still exists, retryable)",
    async (step) => {
      mockDeleteAccount.mockResolvedValue({ ok: false, reason: "failed", step });

      const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

      const json = await expectInternalError(res);
      // Internal step names are not leaked to the client.
      expect(JSON.stringify(json)).not.toContain(step);
      expect(mockClearAuthSession).not.toHaveBeenCalled();
    },
  );

  it("500 (not a crash) if deleteAccount throws unexpectedly", async () => {
    mockDeleteAccount.mockRejectedValue(new Error("unexpected"));

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    await expectInternalError(res);
    expect(mockClearAuthSession).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/account — re-auth rate limit (step 0, account_reauth)", () => {
  it("charges one attempt on the session client, with no arguments, before deleteAccount", async () => {
    const order: string[] = [];
    mockServerRpc.mockImplementation(async () => {
      order.push("consume");
      return { data: true, error: null };
    });
    mockDeleteAccount.mockImplementation(async () => {
      order.push("delete");
      return { ok: true };
    });

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    expect(res.status).toBe(204);
    expect(mockServerRpc).toHaveBeenCalledTimes(1);
    expect(mockServerRpc).toHaveBeenCalledWith("consume_account_reauth_attempt");
    expect(order).toEqual(["consume", "delete"]);
  });

  it("at the limit → 429 rate_limited/account_reauth with retry_after = next UTC midnight; GoTrue never called", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T21:30:00.000Z"));
    useRealDeleteAccount();
    mockServerRpc.mockResolvedValue({ data: false, error: null });

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: "rate_limited",
      kind: "account_reauth",
      retry_after: "2026-11-10T00:00:00.000Z",
    });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
    expect(mockSupabaseJsCreateClient).not.toHaveBeenCalled();
    expect(mockClearAuthSession).not.toHaveBeenCalled();
  });

  it("the 11th attempt in a UTC day → 429 without calling GoTrue; the first 10 reach it", async () => {
    useRealDeleteAccount();
    let used = 0;
    mockServerRpc.mockImplementation(async () => {
      if (used >= 10) return { data: false, error: null };
      used += 1;
      return { data: true, error: null };
    });

    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await DELETE(req({ password: "wrong-guess", confirm: "DELETE" }));
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(403));
    expect(statuses[10]).toBe(429);
    expect(mockServerRpc).toHaveBeenCalledTimes(11);
    expect(mockSignInWithPassword).toHaveBeenCalledTimes(10);
  });

  it("positive control: an allowed attempt does reach GoTrue through the real path", async () => {
    useRealDeleteAccount();

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    expect(res.status).toBe(403);
    expect(mockSignInWithPassword).toHaveBeenCalledTimes(1);
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: EMAIL,
      password: PASSWORD,
    });
  });

  it("RPC error → 500 internal_error (fails closed); GoTrue never called", async () => {
    useRealDeleteAccount();
    mockServerRpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    });

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    const json = await expectInternalError(res);
    expect(json.kind).toBeUndefined();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
    expect(mockClearAuthSession).not.toHaveBeenCalled();
  });

  it("RPC rejecting (network) → 500; GoTrue never called", async () => {
    useRealDeleteAccount();
    mockServerRpc.mockRejectedValue(new Error("fetch failed"));

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    await expectInternalError(res);
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it("a non-boolean RPC result → 500; GoTrue never called", async () => {
    useRealDeleteAccount();
    mockServerRpc.mockResolvedValue({ data: null, error: null });

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    await expectInternalError(res);
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it("session client creation failing → 500; GoTrue never called", async () => {
    useRealDeleteAccount();
    mockCreateServerClient.mockRejectedValue(new Error("cookies unavailable"));

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    await expectInternalError(res);
    expect(mockServerRpc).not.toHaveBeenCalled();
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it.each([
    ["23503 (FK to auth.users: user already deleted)", "23503"],
    ["42501 (unauthenticated: session no longer resolves)", "42501"],
  ])(
    "concurrent deletion: RPC error %s → 401, not 500; GoTrue never called",
    async (_label, code) => {
      useRealDeleteAccount();
      mockServerRpc.mockResolvedValue({
        data: null,
        error: { code, message: "rejected" },
      });

      const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
      expect(mockDeleteAccount).not.toHaveBeenCalled();
      expect(mockSignInWithPassword).not.toHaveBeenCalled();
      expect(mockClearAuthSession).not.toHaveBeenCalled();
    },
  );

  it("the 429 body never echoes the password", async () => {
    mockServerRpc.mockResolvedValue({ data: false, error: null });

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    expect(res.status).toBe(429);
    expect(await res.text()).not.toContain(PASSWORD);
  });
});
