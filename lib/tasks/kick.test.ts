import { afterEach, describe, expect, it, vi } from "vitest";

import { kickWorker, KICK_TIMEOUT_MS, resolveWorkerTickUrl } from "@/lib/tasks/kick";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveWorkerTickUrl", () => {
  it("uses APP_BASE_URL, tolerating a trailing slash", () => {
    expect(resolveWorkerTickUrl({ APP_BASE_URL: "https://kalify.app/" })).toBe(
      "https://kalify.app/api/worker/tick",
    );
  });

  it("falls back to https://VERCEL_PROJECT_PRODUCTION_URL", () => {
    expect(resolveWorkerTickUrl({ VERCEL_PROJECT_PRODUCTION_URL: "kalify.vercel.app" })).toBe(
      "https://kalify.vercel.app/api/worker/tick",
    );
  });

  it("prefers APP_BASE_URL over the Vercel fallback", () => {
    expect(
      resolveWorkerTickUrl({
        APP_BASE_URL: "https://kalify.app",
        VERCEL_PROJECT_PRODUCTION_URL: "kalify.vercel.app",
      }),
    ).toBe("https://kalify.app/api/worker/tick");
  });

  it("returns null when unset or invalid", () => {
    expect(resolveWorkerTickUrl({})).toBeNull();
    expect(resolveWorkerTickUrl({ APP_BASE_URL: "not a url" })).toBeNull();
    expect(resolveWorkerTickUrl({ APP_BASE_URL: "ftp://kalify.app" })).toBeNull();
  });
});

describe("kickWorker", () => {
  const env = { WORKER_SECRET: "s3cret", APP_BASE_URL: "https://kalify.app" };

  it("is a logged no-op on a non-production Vercel deployment, even with a secret", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn();
    expect(await kickWorker({ env: { ...env, VERCEL_ENV: "preview" }, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(info.mock.calls.flat().join(" ")).toContain("non-production");
  });

  it("kicks on production (VERCEL_ENV=production)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    expect(await kickWorker({ env: { ...env, VERCEL_ENV: "production" }, fetchImpl })).toBe(true);
  });

  it("does nothing without WORKER_SECRET (preview/local)", async () => {
    const fetchImpl = vi.fn();
    expect(await kickWorker({ env: { APP_BASE_URL: "https://kalify.app" }, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing (with a warning) without a base URL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn();
    expect(await kickWorker({ env: { WORKER_SECRET: "s3cret" }, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the bearer secret and kick trigger with a 3 s timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));

    expect(await kickWorker({ env, fetchImpl })).toBe(true);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://kalify.app/api/worker/tick");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer s3cret");
    expect(init.body).toBe('{"trigger":"kick"}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(KICK_TIMEOUT_MS);
  });

  it("returns false on a non-202 answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    expect(await kickWorker({ env, fetchImpl })).toBe(false);
  });

  it("swallows network errors and timeouts, logging only the error name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error("connect ECONNREFUSED https://kalify.app?secret=s3cret");
    err.name = "TimeoutError";
    const fetchImpl = vi.fn().mockRejectedValue(err);

    expect(await kickWorker({ env, fetchImpl })).toBe(false);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("TimeoutError");
    expect(logged).not.toContain("s3cret");
  });
});
