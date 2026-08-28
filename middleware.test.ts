import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `createServerClient` is mocked so we can drive `auth.getUser()`'s
// resolved value / rejection / thrown error without needing a real
// Supabase project or env vars. `mockGetUser` is declared via `vi.hoisted`
// so it's available inside the (hoisted) `vi.mock` factory below.
const { mockGetUser, mockCreateServerClient } = vi.hoisted(() => {
  return {
    mockGetUser: vi.fn(),
    mockCreateServerClient: vi.fn(),
  };
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: mockCreateServerClient,
}));

// Imported after the mock is registered so `middleware.ts` picks up the
// mocked `@supabase/ssr` module.
const { middleware } = await import("./middleware");

function makeRequest(pathname: string) {
  return new NextRequest(new URL(pathname, "http://localhost:3000"));
}

function defaultClientImpl() {
  return {
    auth: { getUser: mockGetUser },
  };
}

beforeEach(() => {
  mockCreateServerClient.mockReset();
  mockGetUser.mockReset();
  mockCreateServerClient.mockImplementation(defaultClientImpl);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function asAuthenticated() {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1" } },
    error: null,
  });
}

function asLoggedOut() {
  mockGetUser.mockResolvedValue({
    data: { user: null },
    error: null,
  });
}

describe("middleware redirect matrix", () => {
  describe("unauthenticated user hitting a protected path", () => {
    beforeEach(() => {
      asLoggedOut();
    });

    it.each([
      "/dashboard",
      "/resumes",
      "/jobs",
      "/matches",
      "/resumes/123",
    ])("redirects %s to /login", async (path) => {
      const res = await middleware(makeRequest(path));
      expect(res.headers.get("location")).toBe("http://localhost:3000/login");
      expect([307, 308, 302, 303]).toContain(res.status);
    });
  });

  describe("authenticated user hitting an auth-only page", () => {
    beforeEach(() => {
      asAuthenticated();
    });

    it.each(["/login", "/signup"])(
      "redirects %s to /dashboard",
      async (path) => {
        const res = await middleware(makeRequest(path));
        expect(res.headers.get("location")).toBe(
          "http://localhost:3000/dashboard",
        );
      },
    );
  });

  describe("public path '/'", () => {
    it("renders normally when logged out", async () => {
      asLoggedOut();
      const res = await middleware(makeRequest("/"));
      expect(res.headers.get("location")).toBeNull();
    });

    it("renders normally when authenticated", async () => {
      asAuthenticated();
      const res = await middleware(makeRequest("/"));
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("authenticated user hitting a protected path", () => {
    it("does not redirect (renders normally)", async () => {
      asAuthenticated();
      const res = await middleware(makeRequest("/dashboard"));
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("unauthenticated user hitting a public/non-listed path", () => {
    it("does not redirect a path outside the protected list", async () => {
      asLoggedOut();
      const res = await middleware(makeRequest("/some-random-page"));
      expect(res.headers.get("location")).toBeNull();
    });
  });
});

describe("middleware failure fallback (must never 500 / throw)", () => {
  it("falls back to logged-out when createServerClient throws synchronously (e.g. missing/invalid env vars)", async () => {
    mockCreateServerClient.mockImplementation(() => {
      throw new Error("supabaseUrl is required.");
    });

    await expect(
      middleware(makeRequest("/dashboard")),
    ).resolves.not.toThrow();

    const protectedRes = await middleware(makeRequest("/dashboard"));
    expect(protectedRes.status).not.toBe(500);
    expect(protectedRes.headers.get("location")).toBe(
      "http://localhost:3000/login",
    );

    const publicRes = await middleware(makeRequest("/"));
    expect(publicRes.status).not.toBe(500);
    expect(publicRes.headers.get("location")).toBeNull();
  });

  it("falls back to logged-out when getUser() rejects (transient Auth outage/timeout)", async () => {
    mockGetUser.mockRejectedValue(new Error("network timeout"));

    const protectedRes = await middleware(makeRequest("/resumes"));
    expect(protectedRes.status).not.toBe(500);
    expect(protectedRes.headers.get("location")).toBe(
      "http://localhost:3000/login",
    );

    const publicRes = await middleware(makeRequest("/"));
    expect(publicRes.status).not.toBe(500);
    expect(publicRes.headers.get("location")).toBeNull();
  });

  it("falls back to logged-out when getUser() resolves with a soft error", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "invalid JWT", status: 401 },
    });

    const protectedRes = await middleware(makeRequest("/matches"));
    expect(protectedRes.status).not.toBe(500);
    expect(protectedRes.headers.get("location")).toBe(
      "http://localhost:3000/login",
    );

    const publicRes = await middleware(makeRequest("/"));
    expect(publicRes.status).not.toBe(500);
    expect(publicRes.headers.get("location")).toBeNull();

    // Auth-only pages should still render (not redirect to /dashboard) since
    // the user is treated as logged out.
    const loginRes = await middleware(makeRequest("/login"));
    expect(loginRes.headers.get("location")).toBeNull();
  });

  it("does not crash and treats the request as logged out even when getUser() throws a non-Error value", async () => {
    mockGetUser.mockRejectedValue("weird non-error rejection");

    const res = await middleware(makeRequest("/jobs"));
    expect(res.status).not.toBe(500);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });
});
