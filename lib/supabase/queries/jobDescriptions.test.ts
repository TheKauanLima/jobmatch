import { describe, expect, it, vi } from "vitest";

import {
  createJobDescription,
  decodeJobDescriptionCursor,
  encodeJobDescriptionCursor,
  getJobDescriptionById,
  getJobDescriptionsByIds,
  JOB_DESCRIPTIONS_DEFAULT_LIMIT,
  JobDescriptionQueryError,
  listJobDescriptions,
} from "@/lib/supabase/queries/jobDescriptions";

/**
 * Minimal chainable query-builder mock mirroring the one in
 * lib/supabase/queries/resumes.test.ts, extended with `.limit()`, `.lt()`,
 * and `.or()` for compound-cursor pagination.
 */
function makeQueryBuilder(resolvedValue: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];

  const builder: Record<string, unknown> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ method: name, args });
      return builder;
    };

  builder.select = record("select");
  builder.insert = record("insert");
  builder.eq = record("eq");
  builder.in = record("in");
  builder.order = record("order");
  builder.limit = record("limit");
  builder.lt = record("lt");
  builder.or = record("or");
  builder.maybeSingle = vi.fn().mockResolvedValue(resolvedValue);
  builder.single = vi.fn().mockResolvedValue(resolvedValue);
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolvedValue).then(resolve);

  return { builder, calls };
}

function makeClient(builder: unknown) {
  return {
    from: vi.fn().mockReturnValue(builder),
  } as never;
}

const TEST_UUID = "11111111-1111-1111-1111-111111111111";

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TEST_UUID,
    submitted_by: "user-1",
    title: "Software Engineer",
    company: "Acme",
    description: "Build things.",
    source_url: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("listJobDescriptions", () => {
  it("orders by created_at desc and requests limit + 1 rows (no user_id filter — shared data)", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, { limit: 20 });

    expect(calls.some((c) => c.method === "order")).toBe(true);
    expect(calls).toContainEqual({ method: "limit", args: [21] });
    expect(calls.some((c) => c.method === "eq")).toBe(false);
  });

  it("applies a compound `(created_at, id) < (cursor)` filter via .or() when a cursor is given", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, {
      limit: 20,
      cursor: `2026-01-01T00:00:00.000Z_${TEST_UUID}`,
    });

    const orCall = calls.find((c) => c.method === "or");
    expect(orCall).toBeDefined();
    expect(orCall?.args[0]).toBe(
      `created_at.lt.2026-01-01T00:00:00.000Z,and(created_at.eq.2026-01-01T00:00:00.000Z,id.lt.${TEST_UUID})`,
    );
    // The old strict single-column filter must not be used any more — it's
    // exactly the filter that made tied rows permanently unreachable.
    expect(calls.some((c) => c.method === "lt")).toBe(false);
  });

  it("does not filter by cursor when none is given", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, { limit: 20, cursor: null });

    expect(calls.some((c) => c.method === "or")).toBe(false);
    expect(calls.some((c) => c.method === "lt")).toBe(false);
  });

  it("does not filter at all when the cursor is malformed (degrades to first page rather than throwing)", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, { limit: 20, cursor: "not-a-cursor" });

    expect(calls.some((c) => c.method === "or")).toBe(false);
  });

  it("defaults to JOB_DESCRIPTIONS_DEFAULT_LIMIT when no limit is given", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, {});

    expect(calls).toContainEqual({
      method: "limit",
      args: [JOB_DESCRIPTIONS_DEFAULT_LIMIT + 1],
    });
  });

  it("reports hasMore=true and trims the extra row when more than `limit` rows come back", async () => {
    const rows = [makeRow({ id: "a" }), makeRow({ id: "b" }), makeRow({ id: "c" })];
    const { builder } = makeQueryBuilder({ data: rows, error: null });
    const client = makeClient(builder);

    const result = await listJobDescriptions(client, { limit: 2 });

    expect(result.hasMore).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("reports hasMore=false when fewer than limit + 1 rows come back", async () => {
    const rows = [makeRow({ id: "a" })];
    const { builder } = makeQueryBuilder({ data: rows, error: null });
    const client = makeClient(builder);

    const result = await listJobDescriptions(client, { limit: 20 });

    expect(result.hasMore).toBe(false);
    expect(result.items).toHaveLength(1);
  });

  it("returns [] with hasMore=false when data is null", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    const result = await listJobDescriptions(client, { limit: 20 });
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it("throws JobDescriptionQueryError on a Postgres error", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { message: "connection reset" },
    });
    const client = makeClient(builder);

    await expect(listJobDescriptions(client, { limit: 20 })).rejects.toThrow(
      JobDescriptionQueryError,
    );
  });

  // Fixed: ordering now includes `id` as a secondary tiebreaker so rows
  // sharing an identical `created_at` (plausible with bulk/seeded inserts,
  // or default `now()` timestamps in rapid succession) get a deterministic
  // order, and the compound cursor filter above (`.or(...)`) means a tied
  // row not returned on page 1 is still reachable via `id.lt.` on the next
  // page instead of being permanently skipped by a strict single-column
  // `created_at < cursor` filter. This unit test can only assert what's
  // actually sent to Postgrest, not real DB tie-breaking, but it documents
  // that both sort keys are requested.
  it("orders by created_at desc THEN id desc (secondary tiebreaker for ties)", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, { limit: 20 });

    const orderCalls = calls.filter((c) => c.method === "order");
    expect(orderCalls).toHaveLength(2);
    expect(orderCalls[0]).toEqual({
      method: "order",
      args: ["created_at", { ascending: false }],
    });
    expect(orderCalls[1]).toEqual({
      method: "order",
      args: ["id", { ascending: false }],
    });
  });
});

describe("encodeJobDescriptionCursor / decodeJobDescriptionCursor", () => {
  it("round-trips a (created_at, id) pair", () => {
    const encoded = encodeJobDescriptionCursor({
      created_at: "2026-01-01T00:00:00.000Z",
      id: TEST_UUID,
    });
    expect(decodeJobDescriptionCursor(encoded)).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      id: TEST_UUID,
    });
  });

  it("returns null for a cursor with no separator", () => {
    expect(decodeJobDescriptionCursor("garbage")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(decodeJobDescriptionCursor("")).toBeNull();
  });
});

describe("getJobDescriptionById", () => {
  it("filters by id only (no user_id — shared/readable-by-all data)", async () => {
    const { builder, calls } = makeQueryBuilder({
      data: makeRow(),
      error: null,
    });
    const client = makeClient(builder);

    await getJobDescriptionById(client, "jd-1");

    expect(calls).toContainEqual({ method: "eq", args: ["id", "jd-1"] });
    expect(calls.filter((c) => c.method === "eq")).toHaveLength(1);
  });

  it("returns null when no row exists — caller turns this into 404", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    const result = await getJobDescriptionById(client, "missing-id");
    expect(result).toBeNull();
  });

  it("throws JobDescriptionQueryError on a Postgres error", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { message: "boom" },
    });
    const client = makeClient(builder);

    await expect(getJobDescriptionById(client, "jd-1")).rejects.toThrow(
      JobDescriptionQueryError,
    );
  });

  // Bug fix: a malformed (non-uuid) :id previously propagated Postgres's
  // `22P02 invalid input syntax for type uuid` error as a generic
  // JobDescriptionQueryError (misleading 500), instead of the 404 it
  // deserves — same fix/rationale as `resumes.test.ts`'s equivalent case.
  it("returns null (not a thrown error) for a malformed/non-uuid id (Postgres 22P02)", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { code: "22P02", message: "invalid input syntax for type uuid" },
    });
    const client = makeClient(builder);

    const result = await getJobDescriptionById(client, "not-a-real-id");
    expect(result).toBeNull();
  });

  it("still throws JobDescriptionQueryError for a Postgres error with a different code", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { code: "53300", message: "too many connections" },
    });
    const client = makeClient(builder);

    await expect(getJobDescriptionById(client, "jd-1")).rejects.toThrow(
      JobDescriptionQueryError,
    );
  });
});

describe("getJobDescriptionsByIds", () => {
  it("filters with .in() and no user_id (shared data), used by matches.ts for join shaping", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [makeRow()], error: null });
    const client = makeClient(builder);

    await getJobDescriptionsByIds(client, [TEST_UUID]);

    expect(calls).toContainEqual({ method: "in", args: ["id", [TEST_UUID]] });
    expect(calls.some((c) => c.method === "eq")).toBe(false);
  });

  it("returns [] immediately without querying when ids is empty", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    const result = await getJobDescriptionsByIds(client, []);

    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("returns [] when data is null", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    const result = await getJobDescriptionsByIds(client, [TEST_UUID]);
    expect(result).toEqual([]);
  });

  it("throws JobDescriptionQueryError on a Postgres error", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { message: "boom" },
    });
    const client = makeClient(builder);

    await expect(getJobDescriptionsByIds(client, [TEST_UUID])).rejects.toThrow(
      JobDescriptionQueryError,
    );
  });
});

describe("createJobDescription", () => {
  it("inserts with the caller-supplied submitted_by (never trusting a client-provided owner)", async () => {
    const row = makeRow();
    const { builder, calls } = makeQueryBuilder({ data: row, error: null });
    const client = makeClient(builder);

    const result = await createJobDescription(client, {
      submittedBy: "user-1",
      title: "Software Engineer",
      company: "Acme",
      description: "Build things.",
    });

    expect(result).toEqual(row);
    const insertCall = calls.find((c) => c.method === "insert");
    expect(
      (insertCall?.args[0] as { submitted_by: string }).submitted_by,
    ).toBe("user-1");
  });

  it("defaults company and source_url to null when omitted", async () => {
    const row = makeRow();
    const { builder, calls } = makeQueryBuilder({ data: row, error: null });
    const client = makeClient(builder);

    await createJobDescription(client, {
      submittedBy: "user-1",
      title: "Software Engineer",
      description: "Build things.",
    });

    const insertCall = calls.find((c) => c.method === "insert");
    const inserted = insertCall?.args[0] as {
      company: unknown;
      source_url: unknown;
    };
    expect(inserted.company).toBeNull();
    expect(inserted.source_url).toBeNull();
  });

  it("throws JobDescriptionQueryError when no row is returned", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    await expect(
      createJobDescription(client, {
        submittedBy: "user-1",
        title: "Software Engineer",
        description: "Build things.",
      }),
    ).rejects.toThrow(JobDescriptionQueryError);
  });
});
