import { describe, expect, it, vi } from "vitest";

import type { RateLimitKind } from "@/types/database";
import {
  labelForKind,
  loadUsageLimits,
  RATE_LIMIT_KIND_LABELS,
  sharedResetTime,
  sortLimits,
  type UsageLimit,
} from "@/lib/client/usageLimits";

const RESET = "2026-11-13T00:00:00.000Z";

function limit(kind: string, used = 0, max = 5): UsageLimit {
  return { kind, daily_limit: max, used_today: used, resets_at: RESET };
}

function fetchReturning(response: Response) {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

describe("loadUsageLimits", () => {
  it("requests /api/account/limits without caching", async () => {
    const fetchImpl = fetchReturning(Response.json({ limits: [] }));
    await loadUsageLimits(fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/account/limits");
    expect(init?.cache).toBe("no-store");
  });

  it("200 → loaded, sorted in the documented kind order", async () => {
    const state = await loadUsageLimits(
      fetchReturning(
        Response.json({
          limits: [
            limit("account_reauth", 1, 10),
            limit("resume_report", 2, 5),
            limit("fit_check", 0, 20),
          ],
        }),
      ),
    );
    expect(state).toEqual({
      status: "loaded",
      limits: [
        limit("resume_report", 2, 5),
        limit("fit_check", 0, 20),
        limit("account_reauth", 1, 10),
      ],
    });
  });

  it("200 with an empty list → loaded with no rows (empty state)", async () => {
    expect(
      await loadUsageLimits(fetchReturning(Response.json({ limits: [] }))),
    ).toEqual({ status: "loaded", limits: [] });
  });

  it("drops malformed rows instead of rendering NaN", async () => {
    const state = await loadUsageLimits(
      fetchReturning(
        Response.json({
          limits: [limit("fit_check"), { kind: "x" }, null, "nope"],
        }),
      ),
    );
    expect(state).toEqual({ status: "loaded", limits: [limit("fit_check")] });
  });

  it("401 → unauthorized", async () => {
    expect(
      await loadUsageLimits(
        fetchReturning(Response.json({ error: "Unauthorized" }, { status: 401 })),
      ),
    ).toEqual({ status: "unauthorized" });
  });

  it("500 → error", async () => {
    expect(
      await loadUsageLimits(
        fetchReturning(Response.json({ error: "x" }, { status: 500 })),
      ),
    ).toEqual({ status: "error" });
  });

  it("network failure, bad JSON, or a body without limits → error", async () => {
    expect(
      await loadUsageLimits(vi.fn<typeof fetch>().mockRejectedValue(new TypeError())),
    ).toEqual({ status: "error" });
    expect(
      await loadUsageLimits(fetchReturning(new Response("<html>", { status: 200 }))),
    ).toEqual({ status: "error" });
    expect(
      await loadUsageLimits(fetchReturning(Response.json({ rows: [] }))),
    ).toEqual({ status: "error" });
  });
});

describe("labels", () => {
  it("has a human-readable label and description for every kind", () => {
    const kinds: RateLimitKind[] = [
      "resume_report",
      "refresh_matches",
      "fit_check",
      "url_import",
      "job_listing_create",
      "job_listing_update",
      "account_reauth",
    ];
    expect(Object.keys(RATE_LIMIT_KIND_LABELS).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      const { label, description } = labelForKind(kind);
      expect(label).not.toContain("_");
      expect(description).toBeTruthy();
    }
    expect(labelForKind("account_reauth").label).toBe("Password confirmations");
  });

  it("humanizes an unknown kind instead of showing the raw key", () => {
    expect(labelForKind("some_new_kind")).toEqual({
      label: "Some new kind",
      description: null,
    });
    expect(labelForKind("toString").description).toBeNull();
  });

  it("sorts unknown kinds after known ones", () => {
    expect(
      sortLimits([limit("zzz"), limit("aaa"), limit("account_reauth")]).map(
        (l) => l.kind,
      ),
    ).toEqual(["account_reauth", "aaa", "zzz"]);
  });
});

describe("sharedResetTime", () => {
  it("returns the common reset time, or null when they differ or there are none", () => {
    expect(sharedResetTime([limit("a"), limit("b")])).toBe(RESET);
    expect(
      sharedResetTime([limit("a"), { ...limit("b"), resets_at: "2026-11-14T00:00:00Z" }]),
    ).toBeNull();
    expect(sharedResetTime([])).toBeNull();
  });
});
