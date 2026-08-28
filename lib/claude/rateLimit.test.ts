import { describe, expect, it, vi } from "vitest";

import {
  checkRateLimit,
  DAILY_RATE_LIMITS,
  RateLimitQueryError,
} from "@/lib/claude/rateLimit";

/**
 * Minimal chainable query-builder mock mirroring the one in
 * `lib/supabase/queries/resumes.test.ts` — records every chain call so
 * tests can assert the count query is scoped correctly (by `user_id` and
 * by today's UTC start), and resolves to a fixed `{ count, error }`.
 */
function makeCountClient(resolvedValue: { count: number | null; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ method: name, args });
      return builder;
    };

  builder.select = record("select");
  builder.eq = record("eq");
  builder.gte = record("gte");
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolvedValue).then(resolve);

  const from = vi.fn().mockReturnValue(builder);
  return { client: { from } as never, calls, from };
}

const NOW = new Date("2026-08-27T15:30:00.000Z");

describe("checkRateLimit", () => {
  it("allows the call when under the limit", async () => {
    const { client } = makeCountClient({ count: 5, error: null });

    const result = await checkRateLimit(
      client,
      "user-1",
      { kind: "analyze", limit: 20 },
      NOW,
    );

    expect(result).toEqual({ allowed: true, count: 5, limit: 20 });
  });

  it("blocks the call when exactly at the limit", async () => {
    const { client } = makeCountClient({ count: 20, error: null });

    const result = await checkRateLimit(
      client,
      "user-1",
      { kind: "analyze", limit: 20 },
      NOW,
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.count).toBe(20);
      expect(result.retryAfter).toBe("2026-08-28T00:00:00.000Z");
    }
  });

  it("blocks the call when over the limit", async () => {
    const { client } = makeCountClient({ count: 25, error: null });

    const result = await checkRateLimit(
      client,
      "user-1",
      { kind: "analyze", limit: 20 },
      NOW,
    );

    expect(result.allowed).toBe(false);
  });

  it("treats a null count as zero (allowed)", async () => {
    const { client } = makeCountClient({ count: null, error: null });

    const result = await checkRateLimit(
      client,
      "user-1",
      { kind: "analyze", limit: 20 },
      NOW,
    );

    expect(result).toEqual({ allowed: true, count: 0, limit: 20 });
  });

  it("scopes the count query by user_id and by the start of today (UTC)", async () => {
    const { client, calls } = makeCountClient({ count: 0, error: null });

    await checkRateLimit(client, "user-42", { kind: "analyze", limit: 20 }, NOW);

    expect(calls).toContainEqual({ method: "eq", args: ["user_id", "user-42"] });
    expect(calls).toContainEqual({
      method: "gte",
      args: ["created_at", "2026-08-27T00:00:00.000Z"],
    });
  });

  it("queries resume_analyses for kind 'analyze' and matches for kind 'match'", async () => {
    const analyze = makeCountClient({ count: 0, error: null });
    await checkRateLimit(analyze.client, "user-1", { kind: "analyze", limit: 20 }, NOW);
    expect(analyze.from).toHaveBeenCalledWith("resume_analyses");

    const match = makeCountClient({ count: 0, error: null });
    await checkRateLimit(match.client, "user-1", { kind: "match", limit: 20 }, NOW);
    expect(match.from).toHaveBeenCalledWith("matches");
  });

  it("respects a caller-supplied limit different from the default", async () => {
    const { client } = makeCountClient({ count: 3, error: null });

    const result = await checkRateLimit(client, "user-1", { kind: "analyze", limit: 3 }, NOW);

    expect(result.allowed).toBe(false);
  });

  it("throws RateLimitQueryError on a Postgres error", async () => {
    const { client } = makeCountClient({
      count: null,
      error: { message: "connection reset" },
    });

    await expect(
      checkRateLimit(client, "user-1", { kind: "analyze", limit: 20 }, NOW),
    ).rejects.toThrow(RateLimitQueryError);
  });
});

describe("DAILY_RATE_LIMITS", () => {
  it("is 20/day for both analyze and match, per docs/ARCHITECTURE.md §5", () => {
    expect(DAILY_RATE_LIMITS.analyze).toBe(20);
    expect(DAILY_RATE_LIMITS.match).toBe(20);
  });
});
