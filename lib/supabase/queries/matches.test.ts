import { describe, expect, it, vi } from "vitest";

import {
  createMatch,
  getMatchById,
  listMatchesForResume,
  MatchQueryError,
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
    });
    // The job description's own text/description must NOT leak onto the
    // returned match — only the id/title/company summary.
    expect(result[0].job_description).not.toHaveProperty("description");
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
