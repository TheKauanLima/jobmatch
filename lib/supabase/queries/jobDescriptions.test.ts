import { describe, expect, it, vi } from "vitest";

import {
  createJobDescription,
  decodeJobDescriptionCursor,
  decodeJobDescriptionOffsetCursor,
  encodeJobDescriptionCursor,
  encodeJobDescriptionOffsetCursor,
  getJobDescriptionById,
  getJobDescriptionsByIds,
  JOB_DESCRIPTIONS_DEFAULT_LIMIT,
  JobDescriptionQueryError,
  listJobDescriptions,
  searchJobDescriptions,
  softDeleteJobDescription,
  softDeleteMissingExternalJobDescriptions,
  updateJobDescription,
  upsertExternalJobDescriptions,
} from "@/lib/supabase/queries/jobDescriptions";

/**
 * Minimal chainable query-builder mock mirroring the one in
 * lib/supabase/queries/resumes.test.ts, extended with `.limit()`, `.lt()`,
 * and `.or()` for compound-cursor pagination.
 */
function makeQueryBuilder(resolvedValue: {
  data: unknown;
  error: unknown;
  count?: number | null;
}) {
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
  builder.upsert = record("upsert");
  builder.update = record("update");
  builder.eq = record("eq");
  builder.in = record("in");
  builder.is = record("is");
  builder.order = record("order");
  builder.limit = record("limit");
  builder.lt = record("lt");
  builder.or = record("or");
  builder.like = record("like");
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
    source: "user",
    external_id: null,
    level: null,
    location: null,
    posted_at: null,
    ...overrides,
  };
}

describe("listJobDescriptions", () => {
  it("orders by listed_at desc and requests limit + 1 rows (no user_id filter — shared data)", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, { limit: 20 });

    expect(calls.some((c) => c.method === "order")).toBe(true);
    expect(calls).toContainEqual({ method: "limit", args: [21] });
    expect(calls.some((c) => c.method === "eq")).toBe(false);
  });

  it("applies a compound `(listed_at, id) < (cursor)` filter via .or() when a cursor is given", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, {
      limit: 20,
      cursor: `2026-01-01T00:00:00.000Z_${TEST_UUID}`,
    });

    const orCall = calls.find((c) => c.method === "or");
    expect(orCall).toBeDefined();
    expect(orCall?.args[0]).toBe(
      `listed_at.lt.2026-01-01T00:00:00.000Z,and(listed_at.eq.2026-01-01T00:00:00.000Z,id.lt.${TEST_UUID})`,
    );
    // The old strict single-column filter must not be used any more — it's
    // exactly the filter that made tied rows permanently unreachable.
    expect(calls.some((c) => c.method === "lt")).toBe(false);
  });

  it("filters out soft-deleted rows via .is('deleted_at', null), per docs/ARCHITECTURE.md §10.2", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, { limit: 20 });

    expect(calls).toContainEqual({ method: "is", args: ["deleted_at", null] });
  });

  it("filters by level with .eq() when a level is given", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, { limit: 20, level: "Internship" });

    expect(calls).toContainEqual({ method: "eq", args: ["level", "Internship"] });
  });

  it("does not filter by level when none is given", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, { limit: 20 });

    expect(calls.some((c) => c.method === "eq")).toBe(false);
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
  it("orders by listed_at desc THEN id desc (secondary tiebreaker for ties)", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listJobDescriptions(client, { limit: 20 });

    const orderCalls = calls.filter((c) => c.method === "order");
    expect(orderCalls).toHaveLength(2);
    expect(orderCalls[0]).toEqual({
      method: "order",
      args: ["listed_at", { ascending: false }],
    });
    expect(orderCalls[1]).toEqual({
      method: "order",
      args: ["id", { ascending: false }],
    });
  });
});

describe("encodeJobDescriptionCursor / decodeJobDescriptionCursor", () => {
  it("round-trips a (listed_at, id) pair", () => {
    const encoded = encodeJobDescriptionCursor({
      listed_at: "2026-01-01T00:00:00.000Z",
      id: TEST_UUID,
    });
    expect(decodeJobDescriptionCursor(encoded)).toEqual({
      listedAt: "2026-01-01T00:00:00.000Z",
      id: TEST_UUID,
    });
  });

  it("returns null for a cursor with no separator", () => {
    expect(decodeJobDescriptionCursor("garbage")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(decodeJobDescriptionCursor("")).toBeNull();
  });

  // Cross-mode: an offset cursor (search mode) replayed against the keyset
  // decoder must not be misinterpreted — it should fail this decode and
  // degrade to "no cursor", per docs/ARCHITECTURE.md §9.2.
  it("returns null for an offset-mode cursor replayed in keyset mode", () => {
    expect(decodeJobDescriptionCursor("offset_20")).toBeNull();
  });
});

/**
 * `searchJobDescriptions` calls `supabase.rpc(...)` directly rather than
 * going through `.from(...)`, so it needs its own client mock (the
 * chainable `.from()` builder above doesn't apply here).
 */
function makeRpcClient(resolvedValue: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(resolvedValue);
  const client = { rpc } as unknown as Parameters<typeof searchJobDescriptions>[0];
  return { client, rpc };
}

describe("searchJobDescriptions", () => {
  it("calls the search_job_descriptions RPC with the expected args (query, level, limit+1, offset)", async () => {
    const { client, rpc } = makeRpcClient({ data: [], error: null });

    await searchJobDescriptions(client, {
      query: "engineer",
      limit: 20,
      offset: 40,
      level: "Internship",
    });

    expect(rpc).toHaveBeenCalledWith("search_job_descriptions", {
      search_query: "engineer",
      level_filter: "Internship",
      category_filter: null,
      state_filter: null,
      remote_only: false,
      sort_mode: "relevance",
      limit_count: 21,
      offset_count: 40,
    });
  });

  it("defaults level_filter to null and offset to 0 when omitted", async () => {
    const { client, rpc } = makeRpcClient({ data: [], error: null });

    await searchJobDescriptions(client, { query: "engineer" });

    expect(rpc).toHaveBeenCalledWith("search_job_descriptions", {
      search_query: "engineer",
      level_filter: null,
      category_filter: null,
      state_filter: null,
      remote_only: false,
      sort_mode: "relevance",
      limit_count: JOB_DESCRIPTIONS_DEFAULT_LIMIT + 1,
      offset_count: 0,
    });
  });

  it("defaults to JOB_DESCRIPTIONS_DEFAULT_LIMIT when no limit is given", async () => {
    const { client, rpc } = makeRpcClient({ data: [], error: null });

    await searchJobDescriptions(client, { query: "engineer" });

    expect(rpc).toHaveBeenCalledWith(
      "search_job_descriptions",
      expect.objectContaining({ limit_count: JOB_DESCRIPTIONS_DEFAULT_LIMIT + 1 }),
    );
  });

  it("clamps a negative offset to 0", async () => {
    const { client, rpc } = makeRpcClient({ data: [], error: null });

    await searchJobDescriptions(client, { query: "engineer", offset: -5 });

    expect(rpc).toHaveBeenCalledWith(
      "search_job_descriptions",
      expect.objectContaining({ offset_count: 0 }),
    );
  });

  // `listJobDescriptions` treats an empty-string `level` as "no filter"
  // (`if (params.level) { query = query.eq(...) }`); `searchJobDescriptions`
  // mirrors that via `params.level || null` so an empty string also
  // substitutes to `null` rather than being sent through verbatim. Against
  // the real RPC (`level_filter is null or level = level_filter`), sending
  // `level_filter: ""` would filter to `level = ''`, which matches no real
  // row (every job_description's `level` is either NULL or a non-empty
  // string) — an empty `?level=` combined with `?q=` must fall back to "no
  // level filter" per docs/ARCHITECTURE.md §2/§9.3 ("omitted/empty means no
  // filter"), not silently return zero results.
  it("treats an empty-string level as no filter, same as listJobDescriptions", async () => {
    const { client, rpc } = makeRpcClient({ data: [], error: null });

    await searchJobDescriptions(client, { query: "engineer", level: "" });

    expect(rpc).toHaveBeenCalledWith(
      "search_job_descriptions",
      expect.objectContaining({ level_filter: null }),
    );
  });

  it("reports hasMore=true and trims the extra row when more than `limit` rows come back", async () => {
    const rows = [makeRow({ id: "a" }), makeRow({ id: "b" }), makeRow({ id: "c" })];
    const { client } = makeRpcClient({ data: rows, error: null });

    const result = await searchJobDescriptions(client, { query: "x", limit: 2 });

    expect(result.hasMore).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("reports hasMore=false when fewer than limit + 1 rows come back", async () => {
    const rows = [makeRow({ id: "a" })];
    const { client } = makeRpcClient({ data: rows, error: null });

    const result = await searchJobDescriptions(client, { query: "x", limit: 20 });

    expect(result.hasMore).toBe(false);
    expect(result.items).toHaveLength(1);
  });

  it("returns [] with hasMore=false when data is null", async () => {
    const { client } = makeRpcClient({ data: null, error: null });

    const result = await searchJobDescriptions(client, { query: "x" });

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it("throws JobDescriptionQueryError on a Postgres error", async () => {
    const { client } = makeRpcClient({
      data: null,
      error: { message: "connection reset" },
    });

    await expect(searchJobDescriptions(client, { query: "x" })).rejects.toThrow(
      JobDescriptionQueryError,
    );
  });
});

describe("encodeJobDescriptionOffsetCursor / decodeJobDescriptionOffsetCursor", () => {
  it("round-trips an integer offset", () => {
    const encoded = encodeJobDescriptionOffsetCursor(40);
    expect(encoded).toBe("offset_40");
    expect(decodeJobDescriptionOffsetCursor(encoded)).toBe(40);
  });

  it("round-trips an offset of 0", () => {
    const encoded = encodeJobDescriptionOffsetCursor(0);
    expect(decodeJobDescriptionOffsetCursor(encoded)).toBe(0);
  });

  it("returns null for garbage input", () => {
    expect(decodeJobDescriptionOffsetCursor("not-a-cursor")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(decodeJobDescriptionOffsetCursor("")).toBeNull();
  });

  it("returns null for a negative offset string (pattern requires digits only)", () => {
    expect(decodeJobDescriptionOffsetCursor("offset_-5")).toBeNull();
  });

  it("returns null for a non-integer offset string", () => {
    expect(decodeJobDescriptionOffsetCursor("offset_4.5")).toBeNull();
  });

  it("returns null for an unsafe-integer offset (overflow guard)", () => {
    expect(
      decodeJobDescriptionOffsetCursor("offset_9007199254740993"),
    ).toBeNull();
  });

  // Cross-mode: a keyset cursor (non-search mode) replayed against the
  // offset decoder must not be misinterpreted — it should fail this decode
  // and degrade to "no cursor" (offset 0 / first page), per
  // docs/ARCHITECTURE.md §9.2.
  it("returns null for a keyset cursor replayed in offset mode", () => {
    const keysetCursor = encodeJobDescriptionCursor({
      listed_at: "2026-01-01T00:00:00.000Z",
      id: TEST_UUID,
    });
    expect(decodeJobDescriptionOffsetCursor(keysetCursor)).toBeNull();
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
      jobCategory: "software",
      locationStates: [],
      isRemote: false,
    });

    expect(result).toEqual(row);
    const insertCall = calls.find((c) => c.method === "insert");
    expect(
      (insertCall?.args[0] as { submitted_by: string }).submitted_by,
    ).toBe("user-1");
  });

  it("defaults company, source_url, location, and level to null when omitted", async () => {
    const row = makeRow();
    const { builder, calls } = makeQueryBuilder({ data: row, error: null });
    const client = makeClient(builder);

    await createJobDescription(client, {
      submittedBy: "user-1",
      title: "Software Engineer",
      description: "Build things.",
      jobCategory: "software",
      locationStates: [],
      isRemote: false,
    });

    const insertCall = calls.find((c) => c.method === "insert");
    const inserted = insertCall?.args[0] as {
      company: unknown;
      source_url: unknown;
      location: unknown;
      level: unknown;
    };
    expect(inserted.company).toBeNull();
    expect(inserted.source_url).toBeNull();
    expect(inserted.location).toBeNull();
    expect(inserted.level).toBeNull();
  });

  it("inserts location and level when provided", async () => {
    const row = makeRow();
    const { builder, calls } = makeQueryBuilder({ data: row, error: null });
    const client = makeClient(builder);

    await createJobDescription(client, {
      submittedBy: "user-1",
      title: "Software Engineer",
      description: "Build things.",
      location: "Remote",
      level: "Entry Level",
      jobCategory: "software",
      locationStates: [],
      isRemote: true,
    });

    const insertCall = calls.find((c) => c.method === "insert");
    const inserted = insertCall?.args[0] as {
      location: unknown;
      level: unknown;
    };
    expect(inserted.location).toBe("Remote");
    expect(inserted.level).toBe("Entry Level");
  });

  it("throws JobDescriptionQueryError when no row is returned", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    await expect(
      createJobDescription(client, {
        submittedBy: "user-1",
        title: "Software Engineer",
        description: "Build things.",
        jobCategory: "software",
        locationStates: [],
        isRemote: false,
      }),
    ).rejects.toThrow(JobDescriptionQueryError);
  });
});

describe("upsertExternalJobDescriptions", () => {
  function makeUpsertRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      externalId: "ext-1",
      title: "Software Engineering Intern",
      company: "Acme",
      description: "Build things.",
      sourceUrl: "https://www.themuse.com/jobs/acme/swe-intern",
      level: "Internship",
      location: "New York, NY",
      postedAt: "2026-01-01T00:00:00.000Z",
      jobCategory: "software" as const,
      locationStates: ["NY" as const],
      isRemote: false,
      ...overrides,
    };
  }

  it("returns count: 0 without querying when rows is empty", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    const result = await upsertExternalJobDescriptions(client, "themuse", []);

    expect(result).toEqual({ count: 0 });
    expect(calls).toEqual([]);
  });

  it("upserts with submitted_by: null and the given source, keyed on (source, external_id)", async () => {
    const { builder, calls } = makeQueryBuilder({
      data: [],
      error: null,
      count: 1,
    });
    const client = makeClient(builder);

    await upsertExternalJobDescriptions(client, "themuse", [makeUpsertRow()]);

    const upsertCall = calls.find((c) => c.method === "upsert");
    expect(upsertCall).toBeDefined();
    const [rows, options] = upsertCall!.args as [
      Record<string, unknown>[],
      Record<string, unknown>,
    ];
    expect(rows[0]).toMatchObject({
      source: "themuse",
      external_id: "ext-1",
      title: "Software Engineering Intern",
      submitted_by: null,
    });
    expect(options).toMatchObject({ onConflict: "source,external_id" });
  });

  it("writes deleted_at: null so a listing that reappears on its board is shown again (§7.7.6)", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null, count: 1 });
    const client = makeClient(builder);

    await upsertExternalJobDescriptions(client, "greenhouse", [makeUpsertRow()]);

    const [rows] = calls.find((c) => c.method === "upsert")!.args as [
      Record<string, unknown>[],
    ];
    expect(rows[0]).toMatchObject({ source: "greenhouse", deleted_at: null });
  });

  it("sums counts across batches larger than the batch size", async () => {
    const { builder } = makeQueryBuilder({
      data: [],
      error: null,
      count: 50,
    });
    const client = makeClient(builder);

    const rows = Array.from({ length: 120 }, (_, i) =>
      makeUpsertRow({ externalId: `ext-${i}` }),
    );

    const result = await upsertExternalJobDescriptions(client, "themuse", rows);

    // 3 batches of <=50 -> mocked count 50 each -> 150 total.
    expect(result.count).toBe(150);
  });

  it("throws JobDescriptionQueryError on a Postgres error", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { message: "constraint violation" },
    });
    const client = makeClient(builder);

    await expect(
      upsertExternalJobDescriptions(client, "themuse", [makeUpsertRow()]),
    ).rejects.toThrow(JobDescriptionQueryError);
  });
});

describe("softDeleteMissingExternalJobDescriptions (§7.7.6)", () => {
  /**
   * A client whose every `from()` call gets a fresh chainable builder that
   * resolves to the next queued result, so the select and each update chunk
   * can be given different outcomes. Records each builder's calls.
   */
  function makeSequencedClient(results: { data: unknown; error: unknown }[]) {
    const builders: { method: string; args: unknown[] }[][] = [];
    const client = {
      from: vi.fn(() => {
        const { builder, calls } = makeQueryBuilder(
          results[builders.length] ?? { data: null, error: null },
        );
        builders.push(calls);
        return builder;
      }),
    } as never;
    return { client, builders };
  }

  it("selects only active rows of this source + token prefix, and updates only the missing ones", async () => {
    const { client, builders } = makeSequencedClient([
      {
        data: [
          { id: "r1", external_id: "acme:1" },
          { id: "r2", external_id: "acme:2" },
          { id: "r3", external_id: "acme:3" },
        ],
        error: null,
      },
      { data: null, error: null },
    ]);

    const result = await softDeleteMissingExternalJobDescriptions(
      client,
      "greenhouse",
      "acme",
      new Set(["acme:2"]),
    );

    expect(result).toEqual({ count: 2 });
    const [select, update] = builders;
    expect(select).toEqual([
      { method: "select", args: ["id, external_id"] },
      { method: "eq", args: ["source", "greenhouse"] },
      { method: "like", args: ["external_id", "acme:%"] },
      { method: "is", args: ["deleted_at", null] },
    ]);
    expect(update[0].method).toBe("update");
    expect(update[0].args[0]).toEqual({ deleted_at: expect.any(String) });
    expect(update).toContainEqual({ method: "in", args: ["id", ["r1", "r3"]] });
    expect(update).toContainEqual({ method: "eq", args: ["source", "greenhouse"] });
    expect(update).toContainEqual({ method: "is", args: ["deleted_at", null] });
  });

  it("does not issue an update when nothing is missing", async () => {
    const { client, builders } = makeSequencedClient([
      { data: [{ id: "r1", external_id: "acme:1" }], error: null },
    ]);

    const result = await softDeleteMissingExternalJobDescriptions(
      client,
      "lever",
      "acme",
      new Set(["acme:1"]),
    );

    expect(result).toEqual({ count: 0 });
    expect(builders).toHaveLength(1);
  });

  it("updates in chunks of 100 ids", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `r${i}`,
      external_id: `acme:${i}`,
    }));
    const { client, builders } = makeSequencedClient([
      { data: rows, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);

    const result = await softDeleteMissingExternalJobDescriptions(
      client,
      "greenhouse",
      "acme",
      new Set(),
    );

    expect(result).toEqual({ count: 250 });
    const chunkSizes = builders
      .slice(1)
      .map((calls) => (calls.find((c) => c.method === "in")!.args[1] as string[]).length);
    expect(chunkSizes).toEqual([100, 100, 50]);
  });

  it("throws JobDescriptionQueryError when the select fails, without updating", async () => {
    const { client, builders } = makeSequencedClient([
      { data: null, error: { message: "boom" } },
    ]);

    await expect(
      softDeleteMissingExternalJobDescriptions(client, "greenhouse", "acme", new Set()),
    ).rejects.toThrow(JobDescriptionQueryError);
    expect(builders).toHaveLength(1);
  });

  it("throws JobDescriptionQueryError when an update chunk fails", async () => {
    const { client } = makeSequencedClient([
      { data: [{ id: "r1", external_id: "acme:1" }], error: null },
      { data: null, error: { message: "boom" } },
    ]);

    await expect(
      softDeleteMissingExternalJobDescriptions(client, "greenhouse", "acme", new Set()),
    ).rejects.toThrow(JobDescriptionQueryError);
  });

  it.each(["", "Acme", "acme%", "ac_me", "-acme", "a:b"])(
    "refuses an invalid token %j before querying (LIKE-safety)",
    async (token) => {
      const { client, builders } = makeSequencedClient([]);

      await expect(
        softDeleteMissingExternalJobDescriptions(client, "greenhouse", token, new Set()),
      ).rejects.toThrow(JobDescriptionQueryError);
      expect(builders).toHaveLength(0);
    },
  );
});

describe("updateJobDescription — per docs/ARCHITECTURE.md §10.3", () => {
  it("scopes the update by both id AND submitted_by (the 'checked twice' ownership pattern)", async () => {
    const row = makeRow({ title: "New Title" });
    const { builder, calls } = makeQueryBuilder({ data: row, error: null });
    const client = makeClient(builder);

    await updateJobDescription(client, {
      id: TEST_UUID,
      submittedBy: "user-1",
      patch: { title: "New Title" },
    });

    expect(calls).toContainEqual({ method: "eq", args: ["id", TEST_UUID] });
    expect(calls).toContainEqual({ method: "eq", args: ["submitted_by", "user-1"] });
  });

  it("returns the updated row when a row matched", async () => {
    const row = makeRow({ title: "New Title" });
    const { builder } = makeQueryBuilder({ data: row, error: null });
    const client = makeClient(builder);

    const result = await updateJobDescription(client, {
      id: TEST_UUID,
      submittedBy: "user-1",
      patch: { title: "New Title" },
    });

    expect(result).toEqual(row);
  });

  it("returns null when no row matched (not found, not owned, or a themuse row) — caller turns this into 403", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    const result = await updateJobDescription(client, {
      id: TEST_UUID,
      submittedBy: "attacker",
      patch: { title: "Hijacked" },
    });

    expect(result).toBeNull();
  });

  it("only writes columns present (!== undefined) in the patch — an absent key is left off the update payload entirely", async () => {
    const row = makeRow();
    const { builder, calls } = makeQueryBuilder({ data: row, error: null });
    const client = makeClient(builder);

    await updateJobDescription(client, {
      id: TEST_UUID,
      submittedBy: "user-1",
      patch: { title: "New Title" },
    });

    const updateCall = calls.find((c) => c.method === "update");
    const written = updateCall?.args[0] as Record<string, unknown>;
    expect(written).toEqual({ title: "New Title" });
    expect(written).not.toHaveProperty("company");
    expect(written).not.toHaveProperty("location");
  });

  it("writes an explicit null for a nullable field to clear it (distinct from an absent/undefined key)", async () => {
    const row = makeRow({ company: null });
    const { builder, calls } = makeQueryBuilder({ data: row, error: null });
    const client = makeClient(builder);

    await updateJobDescription(client, {
      id: TEST_UUID,
      submittedBy: "user-1",
      patch: { company: null },
    });

    const updateCall = calls.find((c) => c.method === "update");
    const written = updateCall?.args[0] as Record<string, unknown>;
    expect(written).toHaveProperty("company", null);
  });

  it("returns null (not a thrown error) for a malformed/non-uuid id (Postgres 22P02)", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { code: "22P02", message: "invalid input syntax for type uuid" },
    });
    const client = makeClient(builder);

    const result = await updateJobDescription(client, {
      id: "not-a-real-id",
      submittedBy: "user-1",
      patch: { title: "x" },
    });
    expect(result).toBeNull();
  });

  it("throws JobDescriptionQueryError for a Postgres error with a different code", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { code: "53300", message: "too many connections" },
    });
    const client = makeClient(builder);

    await expect(
      updateJobDescription(client, {
        id: TEST_UUID,
        submittedBy: "user-1",
        patch: { title: "x" },
      }),
    ).rejects.toThrow(JobDescriptionQueryError);
  });
});

describe("softDeleteJobDescription — per docs/ARCHITECTURE.md §10.1/§10.3", () => {
  it("scopes the update by both id AND submitted_by", async () => {
    const { builder, calls } = makeQueryBuilder({ data: { id: TEST_UUID }, error: null });
    const client = makeClient(builder);

    await softDeleteJobDescription(client, { id: TEST_UUID, submittedBy: "user-1" });

    expect(calls).toContainEqual({ method: "eq", args: ["id", TEST_UUID] });
    expect(calls).toContainEqual({ method: "eq", args: ["submitted_by", "user-1"] });
  });

  it("sets deleted_at to a timestamp (soft delete, not a real DELETE)", async () => {
    const { builder, calls } = makeQueryBuilder({ data: { id: TEST_UUID }, error: null });
    const client = makeClient(builder);

    await softDeleteJobDescription(client, { id: TEST_UUID, submittedBy: "user-1" });

    const updateCall = calls.find((c) => c.method === "update");
    const written = updateCall?.args[0] as Record<string, unknown>;
    expect(typeof written.deleted_at).toBe("string");
    expect(calls.some((c) => c.method === "delete")).toBe(false);
  });

  it("returns true when a row matched", async () => {
    const { builder } = makeQueryBuilder({ data: { id: TEST_UUID }, error: null });
    const client = makeClient(builder);

    const result = await softDeleteJobDescription(client, {
      id: TEST_UUID,
      submittedBy: "user-1",
    });
    expect(result).toBe(true);
  });

  it("returns false when no row matched (not found, not owned, or a themuse row)", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    const result = await softDeleteJobDescription(client, {
      id: TEST_UUID,
      submittedBy: "attacker",
    });
    expect(result).toBe(false);
  });

  it("is idempotent: deleting an already-deleted row still returns true, not a special error", async () => {
    // An already-soft-deleted row still matches `.eq("id", ...).eq("submitted_by", ...)`
    // (deleted_at being set doesn't remove it from that filter), so re-running
    // the update just re-writes deleted_at and still returns a row.
    const { builder } = makeQueryBuilder({ data: { id: TEST_UUID }, error: null });
    const client = makeClient(builder);

    const result = await softDeleteJobDescription(client, {
      id: TEST_UUID,
      submittedBy: "user-1",
    });
    expect(result).toBe(true);
  });

  it("returns false (not a thrown error) for a malformed/non-uuid id (Postgres 22P02)", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { code: "22P02", message: "invalid input syntax for type uuid" },
    });
    const client = makeClient(builder);

    const result = await softDeleteJobDescription(client, {
      id: "not-a-real-id",
      submittedBy: "user-1",
    });
    expect(result).toBe(false);
  });

  it("throws JobDescriptionQueryError for a Postgres error with a different code", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { code: "53300", message: "too many connections" },
    });
    const client = makeClient(builder);

    await expect(
      softDeleteJobDescription(client, { id: TEST_UUID, submittedBy: "user-1" }),
    ).rejects.toThrow(JobDescriptionQueryError);
  });
});

describe("softDeleteMissingExternalJobDescriptions: LIKE prefix isolation (QA 2026-11-20)", () => {
  function escapeRe(ch: string): string {
    return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Postgres LIKE semantics (`%` any run, `_` one char, `\` escape) as a RegExp. */
  function likeToRegExp(pattern: string): RegExp {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "\\" && i + 1 < pattern.length) {
        out += escapeRe(pattern[++i]);
      } else if (ch === "%") out += "[\\s\\S]*";
      else if (ch === "_") out += "[\\s\\S]";
      else out += escapeRe(ch);
    }
    return new RegExp(`^${out}$`);
  }

  async function likePatternFor(token: string): Promise<string> {
    const calls: { method: string; args: unknown[] }[] = [];
    const { builder, calls: builderCalls } = makeQueryBuilder({ data: [], error: null });
    const client = { from: vi.fn().mockReturnValue(builder) } as never;
    await softDeleteMissingExternalJobDescriptions(client, "greenhouse", token, new Set());
    calls.push(...builderCalls);
    return calls.find((c) => c.method === "like")!.args[1] as string;
  }

  it("'lyft:%' does not match another company's ids that share a prefix ('lyft-foo:123')", async () => {
    const pattern = await likePatternFor("lyft");
    expect(pattern).toBe("lyft:%");
    const re = likeToRegExp(pattern);
    expect(re.test("lyft:123")).toBe(true);
    expect(re.test("lyft-foo:123")).toBe(false);
    expect(re.test("lyftx:123")).toBe(false);
    expect(re.test("xlyft:123")).toBe(false);
  });

  it("a hyphenated token is not a LIKE wildcard and matches only its own ids", async () => {
    const re = likeToRegExp(await likePatternFor("lyft-foo"));
    expect(re.test("lyft-foo:1")).toBe(true);
    expect(re.test("lyft:1")).toBe(false);
    expect(re.test("lyftafoo:1")).toBe(false);
  });

  it("no checked-in company's prefix pattern matches another company's external ids", async () => {
    const { JOB_BOARD_COMPANIES } = await import("@/lib/jobs/sources/companies");
    for (const a of JOB_BOARD_COMPANIES) {
      const re = likeToRegExp(await likePatternFor(a.token));
      for (const b of JOB_BOARD_COMPANIES) {
        if (b.token === a.token) continue;
        expect(re.test(`${b.token}:1`), `${a.token} vs ${b.token}`).toBe(false);
      }
    }
  });

  it.each(["acme\n", "acme\\", "ac*me", "acme:1", "ACME", "acme "])(
    "refuses token %j (wildcard/escape/case/whitespace)",
    async (token) => {
      const from = vi.fn();
      await expect(
        softDeleteMissingExternalJobDescriptions({ from } as never, "lever", token, new Set()),
      ).rejects.toThrow(JobDescriptionQueryError);
      expect(from).not.toHaveBeenCalled();
    },
  );
});
