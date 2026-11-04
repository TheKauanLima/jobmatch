import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireSession, mockDeleteAccount, mockClearAuthSession } =
  vi.hoisted(() => ({
    mockRequireSession: vi.fn(),
    mockDeleteAccount: vi.fn(),
    mockClearAuthSession: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireSession.mockResolvedValue({ user: fakeUser });
  mockDeleteAccount.mockResolvedValue({ ok: true });
  mockClearAuthSession.mockResolvedValue(undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const call of errorSpy.mock.calls) {
    const line = call.map(String).join(" ");
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain(EMAIL);
  }
  errorSpy.mockRestore();
});

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
  });

  it("returns 500 (not a crash) if the session check throws unexpectedly", async () => {
    mockRequireSession.mockRejectedValue(new Error("auth down"));

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    expect(res.status).toBe(500);
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

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.code).toBe("internal_error");
      // Internal step names are not leaked to the client.
      expect(JSON.stringify(json)).not.toContain(step);
      expect(mockClearAuthSession).not.toHaveBeenCalled();
    },
  );

  it("500 (not a crash) if deleteAccount throws unexpectedly", async () => {
    mockDeleteAccount.mockRejectedValue(new Error("unexpected"));

    const res = await DELETE(req({ password: PASSWORD, confirm: "DELETE" }));

    expect(res.status).toBe(500);
    expect(mockClearAuthSession).not.toHaveBeenCalled();
  });
});
