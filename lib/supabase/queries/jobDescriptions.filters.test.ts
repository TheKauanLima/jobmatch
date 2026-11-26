import { describe, expect, it, vi } from "vitest";

import {
  createJobDescription,
  decodeJobDescriptionCursor,
  encodeJobDescriptionCursor,
  listJobDescriptions,
  searchJobDescriptions,
} from "@/lib/supabase/queries/jobDescriptions";

/** QA: §7.8.6 board filters in the query layer (list + search). */
function makeQueryBuilder(resolvedValue: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "insert", "eq", "is", "order", "limit", "or", "contains"]) {
    builder[name] = (...args: unknown[]) => {
      calls.push({ method: name, args });
      return builder;
    };
  }
  builder.single = vi.fn().mockResolvedValue(resolvedValue);
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolvedValue).then(resolve);
  return { builder, calls, client: { from: vi.fn().mockReturnValue(builder) } as never };
}

const UUID = "11111111-1111-1111-1111-111111111111";

describe("listJobDescriptions filters", () => {
  it("filters category with eq(job_category)", async () => {
    const { client, calls } = makeQueryBuilder({ data: [], error: null });
    await listJobDescriptions(client, { category: "data" });
    expect(calls).toContainEqual({ method: "eq", args: ["job_category", "data"] });
    expect(calls.some((c) => c.method === "contains")).toBe(false);
  });

  it("filters a state with contains(location_states) and does NOT include remote rows", async () => {
    const { client, calls } = makeQueryBuilder({ data: [], error: null });
    await listJobDescriptions(client, { location: "CA" });
    expect(calls).toContainEqual({ method: "contains", args: ["location_states", ["CA"]] });
    expect(calls.some((c) => c.method === "eq" && c.args[0] === "is_remote")).toBe(false);
    expect(calls.some((c) => c.method === "or")).toBe(false);
  });

  it("filters remote with eq(is_remote, true) and no state filter", async () => {
    const { client, calls } = makeQueryBuilder({ data: [], error: null });
    await listJobDescriptions(client, { location: "remote" });
    expect(calls).toContainEqual({ method: "eq", args: ["is_remote", true] });
    expect(calls.some((c) => c.method === "contains")).toBe(false);
  });

  it("combines level + category + state + keyset cursor (all AND-ed)", async () => {
    const { client, calls } = makeQueryBuilder({ data: [], error: null });
    await listJobDescriptions(client, {
      level: "Internship",
      category: "software",
      location: "NY",
      cursor: `2026-11-20T10:00:00.123456+00:00_${UUID}`,
    });
    expect(calls).toContainEqual({ method: "eq", args: ["level", "Internship"] });
    expect(calls).toContainEqual({ method: "eq", args: ["job_category", "software"] });
    expect(calls).toContainEqual({ method: "contains", args: ["location_states", ["NY"]] });
    expect(calls).toContainEqual({
      method: "or",
      args: [
        `listed_at.lt.2026-11-20T10:00:00.123456+00:00,and(listed_at.eq.2026-11-20T10:00:00.123456+00:00,id.lt.${UUID})`,
      ],
    });
    expect(calls).toContainEqual({ method: "is", args: ["deleted_at", null] });
  });

  it("orders by listed_at desc then id desc", async () => {
    const { client, calls } = makeQueryBuilder({ data: [], error: null });
    await listJobDescriptions(client, {});
    const orders = calls.filter((c) => c.method === "order").map((c) => c.args);
    expect(orders).toEqual([
      ["listed_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
  });
});

describe("keyset cursor with PostgREST timestamptz output", () => {
  it("round-trips a microsecond, +00:00 listed_at (PostgREST's real format)", () => {
    const cursor = encodeJobDescriptionCursor({ listed_at: "2026-11-20T10:00:00.123456+00:00", id: UUID });
    expect(decodeJobDescriptionCursor(cursor)).toEqual({
      listedAt: "2026-11-20T10:00:00.123456+00:00",
      id: UUID,
    });
  });

  it("rejects a cursor with filter-syntax injection in the timestamp half", () => {
    expect(decodeJobDescriptionCursor(`2026-11-20T10:00:00Z,id.gt.0_${UUID}`)).toBeNull();
    expect(decodeJobDescriptionCursor(`2026-11-20T10:00:00Z_${UUID}),or(id.gt.0`)).toBeNull();
  });
});

describe("searchJobDescriptions filters", () => {
  function rpcClient() {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    return { client: { rpc } as never, rpc };
  }

  it("passes a state as state_filter with remote_only false", async () => {
    const { client, rpc } = rpcClient();
    await searchJobDescriptions(client, { query: "x", location: "TX", category: "data", sort: "recent" });
    expect(rpc).toHaveBeenCalledWith(
      "search_job_descriptions",
      expect.objectContaining({
        category_filter: "data",
        state_filter: "TX",
        remote_only: false,
        sort_mode: "recent",
      }),
    );
  });

  it("passes remote as remote_only true with no state_filter", async () => {
    const { client, rpc } = rpcClient();
    await searchJobDescriptions(client, { query: "x", location: "remote" });
    expect(rpc).toHaveBeenCalledWith(
      "search_job_descriptions",
      expect.objectContaining({ state_filter: null, remote_only: true, sort_mode: "relevance" }),
    );
  });
});

describe("createJobDescription facets", () => {
  it("writes the three facet columns", async () => {
    const { client, calls } = makeQueryBuilder({ data: { id: "x" }, error: null });
    await createJobDescription(client, {
      submittedBy: "u1",
      title: "t",
      description: "d",
      jobCategory: "design",
      locationStates: ["CA"],
      isRemote: true,
    });
    const insert = calls.find((c) => c.method === "insert");
    expect(insert?.args[0]).toMatchObject({
      job_category: "design",
      location_states: ["CA"],
      is_remote: true,
    });
  });
});
