import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockCreateClient, mockVerifyOtp } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockVerifyOtp: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateClient,
}));

const { GET } = await import("@/app/auth/confirm/route");

const ORIGIN = "http://localhost:3000";
const PATH = "/auth/confirm";

function makeRequest(params: Record<string, string | undefined>) {
  const url = new URL(PATH, ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return new NextRequest(url);
}

function locationOf(res: Response): URL {
  const location = res.headers.get("location");
  expect(location).not.toBeNull();
  return new URL(location as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateClient.mockResolvedValue({ auth: { verifyOtp: mockVerifyOtp } });
});

describe("GET /auth/confirm — success path", () => {
  it("valid token_hash + type=recovery + next=/reset-password calls verifyOtp and redirects to /reset-password with the session established", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });

    const res = await GET(
      makeRequest({
        token_hash: "good-token",
        type: "recovery",
        next: "/reset-password",
      }),
    );

    expect(mockVerifyOtp).toHaveBeenCalledWith({
      token_hash: "good-token",
      type: "recovery",
    });

    const location = locationOf(res);
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/reset-password");
    expect(location.searchParams.get("error")).toBeNull();
  });
});

describe("GET /auth/confirm — invalid/expired token", () => {
  it("redirects to /reset-password?error=invalid and never establishes a session", async () => {
    mockVerifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });

    const res = await GET(
      makeRequest({
        token_hash: "bad-token",
        type: "recovery",
        next: "/reset-password",
      }),
    );

    expect(mockVerifyOtp).toHaveBeenCalledWith({
      token_hash: "bad-token",
      type: "recovery",
    });

    const location = locationOf(res);
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/reset-password");
    expect(location.searchParams.get("error")).toBe("invalid");
  });
});

describe("GET /auth/confirm — missing required params", () => {
  it("missing token_hash redirects to the error state without ever calling verifyOtp", async () => {
    const res = await GET(makeRequest({ type: "recovery" }));

    expect(mockVerifyOtp).not.toHaveBeenCalled();
    const location = locationOf(res);
    expect(location.pathname).toBe("/reset-password");
    expect(location.searchParams.get("error")).toBe("invalid");
  });

  it("missing type redirects to the error state without ever calling verifyOtp", async () => {
    const res = await GET(makeRequest({ token_hash: "some-token" }));

    expect(mockVerifyOtp).not.toHaveBeenCalled();
    const location = locationOf(res);
    expect(location.pathname).toBe("/reset-password");
    expect(location.searchParams.get("error")).toBe("invalid");
  });

  it("missing both token_hash and type redirects to the error state without ever calling verifyOtp", async () => {
    const res = await GET(makeRequest({}));

    expect(mockVerifyOtp).not.toHaveBeenCalled();
    const location = locationOf(res);
    expect(location.pathname).toBe("/reset-password");
    expect(location.searchParams.get("error")).toBe("invalid");
  });
});

describe("GET /auth/confirm — open-redirect allowlist (regression)", () => {
  const BYPASS_NEXT_VALUES = [
    "/\\evil.com",
    "//evil.com",
    "/\\/evil.com",
    "https://evil.example.com",
  ];

  it.each(BYPASS_NEXT_VALUES)(
    "next=%s never escapes the origin on the SUCCESS path (valid token)",
    async (bypassNext) => {
      mockVerifyOtp.mockResolvedValue({ error: null });

      const res = await GET(
        makeRequest({
          token_hash: "good-token",
          type: "recovery",
          next: bypassNext,
        }),
      );

      const location = locationOf(res);
      expect(location.origin).toBe(ORIGIN);
      expect(location.host).not.toMatch(/evil/i);
      expect(location.pathname).toBe("/reset-password");
    },
  );

  it.each(BYPASS_NEXT_VALUES)(
    "next=%s never escapes the origin on the ERROR path (invalid token)",
    async (bypassNext) => {
      mockVerifyOtp.mockResolvedValue({ error: { message: "invalid" } });

      const res = await GET(
        makeRequest({
          token_hash: "bad-token",
          type: "recovery",
          next: bypassNext,
        }),
      );

      const location = locationOf(res);
      expect(location.origin).toBe(ORIGIN);
      expect(location.host).not.toMatch(/evil/i);
      expect(location.pathname).toBe("/reset-password");
      expect(location.searchParams.get("error")).toBe("invalid");
    },
  );
});

describe("GET /auth/confirm — non-allowlisted but legitimate-looking next", () => {
  it("next=/dashboard is not used verbatim; falls back to the safe default on success", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });

    const res = await GET(
      makeRequest({
        token_hash: "good-token",
        type: "recovery",
        next: "/dashboard",
      }),
    );

    const location = locationOf(res);
    expect(location.pathname).toBe("/reset-password");
    expect(location.pathname).not.toBe("/dashboard");
  });

  it("next=/dashboard is not used verbatim; falls back to the safe default on error", async () => {
    mockVerifyOtp.mockResolvedValue({ error: { message: "invalid" } });

    const res = await GET(
      makeRequest({
        token_hash: "bad-token",
        type: "recovery",
        next: "/dashboard",
      }),
    );

    const location = locationOf(res);
    expect(location.pathname).toBe("/reset-password");
    expect(location.searchParams.get("error")).toBe("invalid");
  });
});
