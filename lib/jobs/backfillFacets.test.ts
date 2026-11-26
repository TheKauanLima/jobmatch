import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  backfillJobFacets,
  FACET_BACKFILL_DEFAULT_LIMIT,
  FacetBackfillError,
} from "@/lib/jobs/backfillFacets";

/** QA: facet backfill (§7.8.4) against a fake service-role client. */
type Row = { id: string; title: string; location: string | null };

function makeAdmin(opts: {
  rows?: Row[];
  selectError?: { message: string } | null;
  failIds?: Set<string>;
}) {
  const selectCalls: { method: string; args: unknown[] }[] = [];
  const updates: { id: string; values: Record<string, unknown> }[] = [];

  const from = vi.fn(() => {
    const selectBuilder: Record<string, unknown> = {};
    const rec =
      (name: string) =>
      (...args: unknown[]) => {
        selectCalls.push({ method: name, args });
        return selectBuilder;
      };
    selectBuilder.select = rec("select");
    selectBuilder.is = rec("is");
    selectBuilder.order = rec("order");
    selectBuilder.limit = (...args: unknown[]) => {
      selectCalls.push({ method: "limit", args });
      const limit = args[0] as number;
      return Promise.resolve({
        data: opts.selectError ? null : (opts.rows ?? []).slice(0, limit),
        error: opts.selectError ?? null,
      });
    };
    selectBuilder.update = (values: Record<string, unknown>) => ({
      eq: (_col: string, id: string) => {
        updates.push({ id, values });
        return Promise.resolve({
          error: opts.failIds?.has(id) ? { message: "boom" } : null,
        });
      },
    });
    return selectBuilder;
  });

  return { admin: { from } as never, selectCalls, updates };
}

function rows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i).padStart(4, "0")}`,
    title: "Software Engineer Intern",
    location: "Remote - ME",
  }));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("backfillJobFacets", () => {
  it("selects only rows with job_category null, ordered by id, limited", async () => {
    const { admin, selectCalls } = makeAdmin({ rows: [] });

    await backfillJobFacets(admin, { deadlineMs: Date.now() + 10_000 });

    expect(selectCalls).toContainEqual({ method: "select", args: ["id, title, location"] });
    expect(selectCalls).toContainEqual({ method: "is", args: ["job_category", null] });
    expect(selectCalls).toContainEqual({ method: "limit", args: [FACET_BACKFILL_DEFAULT_LIMIT] });
  });

  it("writes all three facets together, derived from title + location", async () => {
    const { admin, updates } = makeAdmin({ rows: rows(1) });

    const result = await backfillJobFacets(admin, { deadlineMs: Date.now() + 10_000 });

    expect(result).toEqual({ updated: 1, remaining: false });
    expect(updates).toEqual([
      {
        id: "id-0000",
        values: { job_category: "software", location_states: ["ME"], is_remote: true },
      },
    ]);
  });

  it("reports remaining=true when it filled exactly `limit` rows", async () => {
    const { admin, updates } = makeAdmin({ rows: rows(10) });

    const result = await backfillJobFacets(admin, { limit: 5, deadlineMs: Date.now() + 10_000 });

    expect(updates).toHaveLength(5);
    expect(result).toEqual({ updated: 5, remaining: true });
  });

  it("does nothing when the deadline has already passed", async () => {
    const { admin, selectCalls, updates } = makeAdmin({ rows: rows(3) });

    const result = await backfillJobFacets(admin, { deadlineMs: 0 });

    expect(result).toEqual({ updated: 0, remaining: true });
    expect(selectCalls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("stops starting updates once the deadline passes mid-run and flags remaining", async () => {
    const { admin, updates } = makeAdmin({ rows: rows(20) });
    let clock = 0;
    // Each now() call advances the clock; deadline hits after a few rows.
    const now = () => clock++;

    const result = await backfillJobFacets(admin, { deadlineMs: 8, now });

    expect(updates.length).toBeGreaterThan(0);
    expect(updates.length).toBeLessThan(20);
    expect(result.updated).toBe(updates.length);
    expect(result.remaining).toBe(true);
  });

  it("throws FacetBackfillError with the partial count when some updates fail, and keeps going", async () => {
    const { admin, updates } = makeAdmin({ rows: rows(6), failIds: new Set(["id-0002"]) });

    const error = await backfillJobFacets(admin, { deadlineMs: Date.now() + 10_000 }).catch((e) => e);

    expect(error).toBeInstanceOf(FacetBackfillError);
    expect(error.updated).toBe(5);
    expect(updates).toHaveLength(6);
  });

  it("throws FacetBackfillError (updated 0) when the select fails", async () => {
    const { admin } = makeAdmin({ selectError: { message: "column job_category does not exist" } });

    const error = await backfillJobFacets(admin, { deadlineMs: Date.now() + 10_000 }).catch((e) => e);

    expect(error).toBeInstanceOf(FacetBackfillError);
    expect(error.updated).toBe(0);
  });

  it("never logs row content on failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = makeAdmin({
      rows: [{ id: "x", title: "Secret Title", location: "Secret Place" }],
      failIds: new Set(["x"]),
    });

    await backfillJobFacets(admin, { deadlineMs: Date.now() + 10_000 }).catch(() => {});

    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("Secret");
  });
});
