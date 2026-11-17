import { describe, expect, it, vi } from "vitest";

import { buildSourceUserAgent, fetchSourceJson, parseRetryAfter, SourceHttpError } from "@/lib/jobs/sources/http";
import { getSourceAdapter, missingAdapterEnv, SOURCE_ADAPTERS } from "@/lib/jobs/sources/registry";
import type { JobSourceAdapter } from "@/lib/jobs/sources/types";

const url = new URL("https://api.example.test/jobs?secret_param=abc");

describe("buildSourceUserAgent (§13.6.7)", () => {
  it("includes APP_BASE_URL and INGEST_CONTACT_EMAIL when set", () => {
    expect(buildSourceUserAgent({ APP_BASE_URL: "https://kalify.example", INGEST_CONTACT_EMAIL: "ops@example.test" })).toBe(
      "Kalify/2.0 (+https://kalify.example; ops@example.test)",
    );
  });

  it("omits missing parts", () => {
    expect(buildSourceUserAgent({ APP_BASE_URL: "https://kalify.example" })).toBe("Kalify/2.0 (+https://kalify.example)");
    expect(buildSourceUserAgent({ INGEST_CONTACT_EMAIL: " ops@example.test " })).toBe("Kalify/2.0 (ops@example.test)");
    expect(buildSourceUserAgent({})).toBe("Kalify/2.0");
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds and HTTP dates; null otherwise", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30);
    expect(parseRetryAfter("Mon, 16 Nov 2026 12:00:45 GMT", now)).toBe(45);
    expect(parseRetryAfter("Mon, 16 Nov 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
  });
});

describe("fetchSourceJson", () => {
  it("GETs JSON with the Kalify User-Agent and returns the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const body = await fetchSourceJson(url, { signal: new AbortController().signal, fetchImpl, env: {} });
    expect(body).toEqual({ ok: 1 });
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe("GET");
    expect(init.headers["User-Agent"]).toBe("Kalify/2.0");
    expect(init.headers.Accept).toBe("application/json");
  });

  it("throws SourceHttpError (host + status only, no body, no query string) on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("listing text that must not leak", { status: 503 }));
    const err = await fetchSourceJson(url, { signal: new AbortController().signal, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceHttpError);
    expect(err.status).toBe(503);
    expect(err.message).toBe("api.example.test returned HTTP 503.");
    expect(err.message).not.toMatch(/listing text|secret_param/);
  });

  it("throws SourceHttpError with a null status on network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const err = await fetchSourceJson(url, { signal: new AbortController().signal, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceHttpError);
    expect(err.status).toBeNull();
  });

  it("propagates the task deadline's abort reason instead of wrapping it", async () => {
    const controller = new AbortController();
    const reason = new Error("deadline");
    const fetchImpl = vi.fn().mockImplementation(async () => {
      controller.abort(reason);
      throw new DOMException("aborted", "AbortError");
    });
    await expect(fetchSourceJson(url, { signal: controller.signal, fetchImpl })).rejects.toBe(reason);
  });

  it("throws SourceHttpError on a non-JSON 200 body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(fetchSourceJson(url, { signal: new AbortController().signal, fetchImpl })).rejects.toBeInstanceOf(SourceHttpError);
  });
});

describe("source registry", () => {
  it("maps themuse to its adapter and nothing else yet (M1.6 adds the rest)", () => {
    expect(Object.keys(SOURCE_ADAPTERS)).toEqual(["themuse"]);
    expect(getSourceAdapter("themuse")?.slug).toBe("themuse");
    expect(getSourceAdapter("greenhouse")).toBeNull();
    expect(getSourceAdapter("constructor" as never)).toBeNull();
  });

  it("every registered adapter's slug matches its key", () => {
    for (const [slug, adapter] of Object.entries(SOURCE_ADAPTERS)) {
      expect(adapter?.slug).toBe(slug);
    }
  });

  it("missingAdapterEnv lists unset or blank variable names", () => {
    const adapter = { requiredEnv: ["A_KEY", "B_KEY", "C_KEY"] } as unknown as JobSourceAdapter;
    expect(missingAdapterEnv(adapter, { A_KEY: "x", B_KEY: "  " })).toEqual(["B_KEY", "C_KEY"]);
  });
});
