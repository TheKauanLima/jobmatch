import { describe, expect, it, vi } from "vitest";

import {
  createMatch,
  decodeMatchCursor,
  encodeMatchCursor,
  getMatchById,
  listMatchesForResume,
  listRecentMatchesForUser,
  MatchQueryError,
  RECENT_MATCHES_DEFAULT_LIMIT,
} from "@/lib/supabase/queries/matches";

/**
 * Minimal chainable query-builder mock mirroring
 * `lib/supabase/queries/resumes.test.ts` — records every chain call so
 * tests can assert on *which* filters were applied (the ownership
 * double-scoping this module documents), and resolves to a fixed
 * `{ data, error }` per table.
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
  builder.or = record("or");
  builder.maybeSingle = vi.fn().mockResolvedValue(resolvedValue);
  builder.single = vi.fn().mockResolvedValue(resolvedValue);
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolvedValue).then(resolve);

  return { builder, calls };
}

/**
 * Multi-table client mock: routes `.from(table)` to a per-table builder so
 * tests can distinguish the `matches` query from the `job_descriptions`
 * join query.
 */
function makeMultiTableClient(builders: Record<string, unknown>) {
  return {
    from: vi.fn((table: string) => builders[table]),
  } as never;
}

const MATCH_ROW = {
  id: "match-1",
  resume_id: "resume-1",
  job_description_id: "jd-1",
  user_id: "user-1",
  score: 82,
  rationale: "Good fit.",
  matched_strengths: ["Node.js"],
  gaps: ["Kubernetes"],
  model: "claude-sonnet-5",
  created_at: "2026-01-01T00:00:00.000Z",
};

const JOB_DESCRIPTION_ROW = {
  id: "jd-1",
  submitted_by: "user-2",
  title: "Backend Engineer",
  company: "Acme",
  description: "Build things.",
  source_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
};

describe("listMatchesForResume — privacy boundary", () => {
  it("scopes the query by both resume_id AND user_id", async () => {
    const { builder: matchesBuilder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeMultiTableClient({ matches: matchesBuilder });

    await listMatchesForResume(client, "user-1", "resume-1");

    expect(calls).toContainEqual({ method: "eq", args: ["resume_id", "resume-1"] });
    expect(calls).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });
  });

  it("returns [] without querying job_descriptions when there are no matches", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({ data: [], error: null });
    const jobDescriptionsFrom = vi.fn();
    const client = makeMultiTableClient({ matches: matchesBuilder, job_descriptions: jobDescriptionsFrom });

    const result = await listMatchesForResume(client, "user-1", "resume-1");

    expect(result).toEqual([]);
  });

  it("joins in the job_description summary (id/title/company) for each match", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({ data: [MATCH_ROW], error: null });
    const { builder: jdBuilder } = makeQueryBuilder({ data: [JOB_DESCRIPTION_ROW], error: null });
    const client = makeMultiTableClient({ matches: matchesBuilder, job_descriptions: jdBuilder });

    const result = await listMatchesForResume(client, "user-1", "resume-1");

    expect(result).toHaveLength(1);
    expect(result[0].job_description).toEqual({
      id: "jd-1",
      title: "Backend Engineer",
      company: "Acme",
      deleted_at: null,
    });
    // The job description's own text/description must NOT leak onto the
    // returned match — only the id/title/company/deleted_at summary.
    expect(result[0].job_description).not.toHaveProperty("description");
  });

  it("passes through a non-null deleted_at (per docs/ARCHITECTURE.md §10.4/§10.5 — powers the 'Removed' badge; the rationale/score/gaps are unaffected)", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({ data: [MATCH_ROW], error: null });
    const { builder: jdBuilder } = makeQueryBuilder({
      data: [{ ...JOB_DESCRIPTION_ROW, deleted_at: "2026-02-01T00:00:00.000Z" }],
      error: null,
    });
    const client = makeMultiTableClient({ matches: matchesBuilder, job_descriptions: jdBuilder });

    const result = await listMatchesForResume(client, "user-1", "resume-1");

    expect(result[0].job_description.deleted_at).toBe("2026-02-01T00:00:00.000Z");
    expect(result[0].rationale).toBe(MATCH_ROW.rationale);
    expect(result[0].score).toBe(MATCH_ROW.score);
  });

  it("falls back to a placeholder summary if the job description is unexpectedly missing (defensive — shouldn't happen given cascade delete)", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({ data: [MATCH_ROW], error: null });
    const { builder: jdBuilder } = makeQueryBuilder({ data: [], error: null });
    const client = makeMultiTableClient({ matches: matchesBuilder, job_descriptions: jdBuilder });

    const result = await listMatchesForResume(client, "user-1", "resume-1");

    expect(result[0].job_description.id).toBe("jd-1");
    expect(result[0].job_description.title).toMatch(/unavailable/i);
  });

  it("throws MatchQueryError on a Postgres error", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({
      data: null,
      error: { message: "connection reset" },
    });
    const client = makeMultiTableClient({ matches: matchesBuilder });

    await expect(listMatchesForResume(client, "user-1", "resume-1")).rejects.toThrow(
      MatchQueryError,
    );
  });
});

const RESUME_ROW = {
  id: "resume-1",
  user_id: "user-1",
  storage_path: "user-1/resume-1.pdf",
  file_name: "resume.pdf",
  file_type: "application/pdf",
  file_size_bytes: 1234,
  extracted_text: "text",
  status: "analyzed",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const MATCH_ROW_2 = {
  ...MATCH_ROW,
  id: "match-2",
  // Same created_at as MATCH_ROW — exercises the `id` tiebreak.
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("listRecentMatchesForUser — privacy boundary", () => {
  it("scopes the query by user_id only (no other request-supplied filter — see the function's docstring)", async () => {
    const { builder: matchesBuilder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeMultiTableClient({ matches: matchesBuilder });

    await listRecentMatchesForUser(client, "user-1", { limit: RECENT_MATCHES_DEFAULT_LIMIT });

    expect(calls).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });
    expect(calls.filter((c) => c.method === "eq")).toHaveLength(1);
    // Requests limit + 1 to derive hasMore without a separate count query.
    expect(calls).toContainEqual({
      method: "limit",
      args: [RECENT_MATCHES_DEFAULT_LIMIT + 1],
    });
  });

  it("orders by created_at desc THEN id desc (secondary tiebreaker for ties)", async () => {
    const { builder: matchesBuilder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeMultiTableClient({ matches: matchesBuilder });

    await listRecentMatchesForUser(client, "user-1", { limit: 5 });

    const orderCalls = calls.filter((c) => c.method === "order");
    expect(orderCalls).toHaveLength(2);
    expect(orderCalls[0]).toEqual({ method: "order", args: ["created_at", { ascending: false }] });
    expect(orderCalls[1]).toEqual({ method: "order", args: ["id", { ascending: false }] });
  });

  it("returns { items: [], hasMore: false } without querying job_descriptions/resumes when there are no matches", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({ data: [], error: null });
    const jobDescriptionsFrom = vi.fn();
    const resumesFrom = vi.fn();
    const client = makeMultiTableClient({
      matches: matchesBuilder,
      job_descriptions: jobDescriptionsFrom,
      resumes: resumesFrom,
    });

    const result = await listRecentMatchesForUser(client, "user-1", { limit: 5 });

    expect(result).toEqual({ items: [], hasMore: false });
    expect(jobDescriptionsFrom).not.toHaveBeenCalled();
    expect(resumesFrom).not.toHaveBeenCalled();
  });

  it("joins in both job_description and resume summaries for each match", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({ data: [MATCH_ROW], error: null });
    const { builder: jdBuilder } = makeQueryBuilder({ data: [JOB_DESCRIPTION_ROW], error: null });
    const { builder: resumesBuilder } = makeQueryBuilder({ data: [RESUME_ROW], error: null });
    const client = makeMultiTableClient({
      matches: matchesBuilder,
      job_descriptions: jdBuilder,
      resumes: resumesBuilder,
    });

    const result = await listRecentMatchesForUser(client, "user-1", { limit: 5 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].job_description).toEqual({
      id: "jd-1",
      title: "Backend Engineer",
      company: "Acme",
      deleted_at: null,
    });
    expect(result.items[0].resume).toEqual({ id: "resume-1", file_name: "resume.pdf" });
  });

  it("scopes the resume join by the caller's own user_id too (never another user's resume)", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({ data: [MATCH_ROW], error: null });
    const { builder: jdBuilder } = makeQueryBuilder({ data: [JOB_DESCRIPTION_ROW], error: null });
    const { builder: resumesBuilder, calls: resumeCalls } = makeQueryBuilder({
      data: [RESUME_ROW],
      error: null,
    });
    const client = makeMultiTableClient({
      matches: matchesBuilder,
      job_descriptions: jdBuilder,
      resumes: resumesBuilder,
    });

    await listRecentMatchesForUser(client, "user-1", { limit: 5 });

    expect(resumeCalls).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });
  });

  it("falls back to a placeholder resume summary if unexpectedly missing", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({ data: [MATCH_ROW], error: null });
    const { builder: jdBuilder } = makeQueryBuilder({ data: [JOB_DESCRIPTION_ROW], error: null });
    const { builder: resumesBuilder } = makeQueryBuilder({ data: [], error: null });
    const client = makeMultiTableClient({
      matches: matchesBuilder,
      job_descriptions: jdBuilder,
      resumes: resumesBuilder,
    });

    const result = await listRecentMatchesForUser(client, "user-1", { limit: 5 });

    expect(result.items[0].resume.id).toBe("resume-1");
    expect(result.items[0].resume.file_name).toMatch(/unavailable/i);
  });

  it("throws MatchQueryError on a Postgres error", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({
      data: null,
      error: { message: "connection reset" },
    });
    const client = makeMultiTableClient({ matches: matchesBuilder });

    await expect(
      listRecentMatchesForUser(client, "user-1", { limit: 5 }),
    ).rejects.toThrow(MatchQueryError);
  });

  describe("cursor pagination (docs/ARCHITECTURE.md §11.1)", () => {
    it("fetches limit + 1 rows and reports hasMore=true, trimming the extra row off items", async () => {
      const rows = [MATCH_ROW, MATCH_ROW_2, { ...MATCH_ROW, id: "match-3" }];
      const { builder: matchesBuilder } = makeQueryBuilder({ data: rows, error: null });
      const { builder: jdBuilder } = makeQueryBuilder({ data: [JOB_DESCRIPTION_ROW], error: null });
      const { builder: resumesBuilder } = makeQueryBuilder({ data: [RESUME_ROW], error: null });
      const client = makeMultiTableClient({
        matches: matchesBuilder,
        job_descriptions: jdBuilder,
        resumes: resumesBuilder,
      });

      const result = await listRecentMatchesForUser(client, "user-1", { limit: 2 });

      expect(result.hasMore).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items.map((i) => i.id)).toEqual(["match-1", "match-2"]);
    });

    it("reports hasMore=false when fewer than limit + 1 rows come back", async () => {
      const { builder: matchesBuilder } = makeQueryBuilder({ data: [MATCH_ROW], error: null });
      const { builder: jdBuilder } = makeQueryBuilder({ data: [JOB_DESCRIPTION_ROW], error: null });
      const { builder: resumesBuilder } = makeQueryBuilder({ data: [RESUME_ROW], error: null });
      const client = makeMultiTableClient({
        matches: matchesBuilder,
        job_descriptions: jdBuilder,
        resumes: resumesBuilder,
      });

      const result = await listRecentMatchesForUser(client, "user-1", { limit: 5 });

      expect(result.hasMore).toBe(false);
      expect(result.items).toHaveLength(1);
    });

    it("applies a compound `(created_at, id) < (cursor)` filter via .or() when a cursor is given", async () => {
      const { builder: matchesBuilder, calls } = makeQueryBuilder({ data: [], error: null });
      const client = makeMultiTableClient({ matches: matchesBuilder });
      const cursorId = "11111111-1111-1111-1111-111111111111";

      await listRecentMatchesForUser(client, "user-1", {
        limit: 5,
        cursor: `2026-01-01T00:00:00.000Z_${cursorId}`,
      });

      const orCall = calls.find((c) => c.method === "or");
      expect(orCall).toBeDefined();
      expect(orCall?.args[0]).toBe(
        `created_at.lt.2026-01-01T00:00:00.000Z,and(created_at.eq.2026-01-01T00:00:00.000Z,id.lt.${cursorId})`,
      );
    });

    it("does not apply an .or() filter when no cursor is given", async () => {
      const { builder: matchesBuilder, calls } = makeQueryBuilder({ data: [], error: null });
      const client = makeMultiTableClient({ matches: matchesBuilder });

      await listRecentMatchesForUser(client, "user-1", { limit: 5 });

      expect(calls.some((c) => c.method === "or")).toBe(false);
    });

    it("degrades to 'no cursor' (first page) rather than throwing on a malformed cursor", async () => {
      const { builder: matchesBuilder, calls } = makeQueryBuilder({ data: [], error: null });
      const client = makeMultiTableClient({ matches: matchesBuilder });

      await listRecentMatchesForUser(client, "user-1", { limit: 5, cursor: "not-a-cursor" });

      expect(calls.some((c) => c.method === "or")).toBe(false);
    });

    it("degrades to 'no cursor' for a cursor from a different context (e.g. a job-descriptions keyset cursor with a non-uuid id) without throwing", async () => {
      const { builder: matchesBuilder, calls } = makeQueryBuilder({ data: [], error: null });
      const client = makeMultiTableClient({ matches: matchesBuilder });

      // Well-formed shape, but not a real match cursor from this table —
      // decodeMatchCursor validates both halves strictly (ISO timestamp +
      // uuid), so a garbage id degrades cleanly instead of building a
      // malformed .or() filter string.
      await expect(
        listRecentMatchesForUser(client, "user-1", {
          limit: 5,
          cursor: "2026-01-01T00:00:00.000Z_not-a-uuid",
        }),
      ).resolves.toEqual({ items: [], hasMore: false });
      expect(calls.some((c) => c.method === "or")).toBe(false);
    });
  });
});

describe("encodeMatchCursor / decodeMatchCursor", () => {
  it("round-trips a (created_at, id) pair", () => {
    const encoded = encodeMatchCursor({
      created_at: "2026-01-01T00:00:00.000Z",
      id: "11111111-1111-1111-1111-111111111111",
    });
    expect(decodeMatchCursor(encoded)).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("returns null for a cursor with no separator", () => {
    expect(decodeMatchCursor("garbage")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(decodeMatchCursor("")).toBeNull();
  });

  it("returns null for a malformed timestamp half", () => {
    expect(decodeMatchCursor("not-a-timestamp_11111111-1111-1111-1111-111111111111")).toBeNull();
  });

  it("returns null for a malformed (non-uuid) id half", () => {
    expect(decodeMatchCursor("2026-01-01T00:00:00.000Z_not-a-uuid")).toBeNull();
  });
});

describe("getMatchById — privacy boundary", () => {
  it("filters by both id AND user_id (not id alone)", async () => {
    const { builder: matchesBuilder, calls } = makeQueryBuilder({ data: null, error: null });
    const client = makeMultiTableClient({ matches: matchesBuilder });

    await getMatchById(client, "attacker-user", "victim-match-id");

    expect(calls).toContainEqual({ method: "eq", args: ["id", "victim-match-id"] });
    expect(calls).toContainEqual({ method: "eq", args: ["user_id", "attacker-user"] });
  });

  it("returns null (not an error) when the row belongs to someone else — caller turns this into 404", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({ data: null, error: null });
    const client = makeMultiTableClient({ matches: matchesBuilder });

    const result = await getMatchById(client, "attacker-user", "victim-match-id");
    expect(result).toBeNull();
  });

  it("returns the match with its joined job_description summary", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({ data: MATCH_ROW, error: null });
    const { builder: jdBuilder } = makeQueryBuilder({ data: JOB_DESCRIPTION_ROW, error: null });
    const client = makeMultiTableClient({ matches: matchesBuilder, job_descriptions: jdBuilder });

    const result = await getMatchById(client, "user-1", "match-1");

    expect(result?.job_description).toEqual({
      id: "jd-1",
      title: "Backend Engineer",
      company: "Acme",
      deleted_at: null,
    });
  });

  it("throws MatchQueryError on a Postgres error instead of silently returning a row", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({
      data: null,
      error: { message: "boom" },
    });
    const client = makeMultiTableClient({ matches: matchesBuilder });

    await expect(getMatchById(client, "user-1", "match-1")).rejects.toThrow(MatchQueryError);
  });

  // Bug fix: a malformed (non-uuid) :id previously propagated Postgres's
  // `22P02 invalid input syntax for type uuid` error as a generic
  // MatchQueryError (misleading 500), instead of the 404 it deserves — same
  // fix/rationale as `resumes.test.ts`'s equivalent case.
  it("returns null (not a thrown error) for a malformed/non-uuid id (Postgres 22P02)", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({
      data: null,
      error: { code: "22P02", message: "invalid input syntax for type uuid" },
    });
    const client = makeMultiTableClient({ matches: matchesBuilder });

    const result = await getMatchById(client, "user-1", "not-a-real-id");
    expect(result).toBeNull();
  });

  it("still throws MatchQueryError for a Postgres error with a different code", async () => {
    const { builder: matchesBuilder } = makeQueryBuilder({
      data: null,
      error: { code: "53300", message: "too many connections" },
    });
    const client = makeMultiTableClient({ matches: matchesBuilder });

    await expect(getMatchById(client, "user-1", "match-1")).rejects.toThrow(MatchQueryError);
  });
});

describe("createMatch", () => {
  it("inserts with the caller-supplied user_id (never trusting a client-provided owner) and the validated Claude result", async () => {
    const { builder, calls } = makeQueryBuilder({ data: MATCH_ROW, error: null });
    const client = makeMultiTableClient({ matches: builder });

    const result = await createMatch(client, {
      resumeId: "resume-1",
      jobDescriptionId: "jd-1",
      userId: "user-1",
      model: "claude-sonnet-5",
      result: {
        score: 82,
        rationale: "Good fit.",
        matched_strengths: ["Node.js"],
        gaps: ["Kubernetes"],
      },
    });

    expect(result).toEqual(MATCH_ROW);
    const insertCall = calls.find((c) => c.method === "insert");
    const inserted = insertCall?.args[0] as { user_id: string; resume_id: string };
    expect(inserted.user_id).toBe("user-1");
    expect(inserted.resume_id).toBe("resume-1");
  });

  it("throws MatchQueryError when no row is returned", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeMultiTableClient({ matches: builder });

    await expect(
      createMatch(client, {
        resumeId: "resume-1",
        jobDescriptionId: "jd-1",
        userId: "user-1",
        model: "claude-sonnet-5",
        result: { score: 1, rationale: "x", matched_strengths: [], gaps: [] },
      }),
    ).rejects.toThrow(MatchQueryError);
  });
});
