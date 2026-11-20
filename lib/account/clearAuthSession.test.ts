import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateClient, mockSignOut, mockCookies, cookieJar, setCalls } =
  vi.hoisted(() => {
    const cookieJar = new Map<string, string>();
    const setCalls: { name: string; value: string; maxAge?: number }[] = [];
    return {
      mockCreateClient: vi.fn(),
      mockSignOut: vi.fn(),
      mockCookies: vi.fn(),
      cookieJar,
      setCalls,
    };
  });

vi.mock("@/lib/supabase/server", () => ({ createClient: mockCreateClient }));
vi.mock("next/headers", () => ({ cookies: mockCookies }));

const { clearAuthSession, isSupabaseAuthCookieName } = await import(
  "@/lib/account/clearAuthSession"
);

beforeEach(() => {
  vi.clearAllMocks();
  cookieJar.clear();
  setCalls.length = 0;
  mockCreateClient.mockResolvedValue({ auth: { signOut: mockSignOut } });
  mockSignOut.mockResolvedValue({ error: null });
  mockCookies.mockResolvedValue({
    getAll: () =>
      [...cookieJar.entries()].map(([name, value]) => ({ name, value })),
    set: (c: { name: string; value: string; maxAge?: number }) => {
      setCalls.push(c);
    },
  });
});

describe("isSupabaseAuthCookieName", () => {
  it.each([
    "sb-xpubgotqrsosvpiwlpyh-auth-token",
    "sb-xpubgotqrsosvpiwlpyh-auth-token.0",
    "sb-xpubgotqrsosvpiwlpyh-auth-token.12",
    "sb-xpubgotqrsosvpiwlpyh-auth-token-code-verifier",
  ])("matches %s", (name) => {
    expect(isSupabaseAuthCookieName(name)).toBe(true);
  });

  it.each(["theme", "sb-ref-other", "auth-token", "xsb-ref-auth-token"])(
    "does not match %s",
    (name) => {
      expect(isSupabaseAuthCookieName(name)).toBe(false);
    },
  );
});

describe("clearAuthSession", () => {
  it("signs out locally and expires every Supabase auth cookie, leaving other cookies alone", async () => {
    cookieJar.set("sb-ref-auth-token.0", "a");
    cookieJar.set("sb-ref-auth-token.1", "b");
    cookieJar.set("theme", "dark");

    await clearAuthSession();

    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
    const expired = setCalls.map((c) => c.name).sort();
    expect(expired).toEqual(["sb-ref-auth-token.0", "sb-ref-auth-token.1"]);
    for (const c of setCalls) {
      expect(c.value).toBe("");
      expect(c.maxAge).toBe(0);
    }
  });

  it("still expires the cookies when signOut throws, and never throws itself", async () => {
    cookieJar.set("sb-ref-auth-token", "a");
    mockSignOut.mockRejectedValue(new Error("user gone"));

    await expect(clearAuthSession()).resolves.toBeUndefined();
    expect(setCalls.map((c) => c.name)).toEqual(["sb-ref-auth-token"]);
  });

  it("never throws even if the cookie store is unavailable", async () => {
    mockCreateClient.mockRejectedValue(new Error("no request scope"));
    mockCookies.mockRejectedValue(new Error("no request scope"));

    await expect(clearAuthSession()).resolves.toBeUndefined();
  });
});
