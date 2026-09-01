import { describe, expect, it, vi } from "vitest";

import {
  AnalysisQueryError,
  createAnalysis,
  getLatestAnalysis,
} from "@/lib/supabase/queries/analyses";

/**
 * Minimal chainable query-builder mock mirroring
 * `lib/supabase/queries/resumes.test.ts` / `lib/supabase/queries/matches.test.ts`
 * — records every chain call so tests can assert on *which* filters were
 * applied (the ownership double-scoping this module documents), and
 * resolves to a fixed `{ data, error }`.
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
  builder.order = record("order");
  builder.limit = record("limit");
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

const ANALYSIS_ROW = {
  id: "analysis-1",
  resume_id: "resume-1",
  user_id: "user-1",
  strengths: [{ label: "Strong backend", detail: "5 years Node.js" }],
  weaknesses: [{ label: "Limited frontend", detail: "No React experience" }],
  summary: "Solid backend engineer.",
  suggested_roles: ["Backend Engineer"],
  model: "claude-sonnet-5",
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("getLatestAnalysis — privacy boundary", () => {
  it("filters by both resume_id AND user_id (not resume_id alone)", async () => {
    const { builder, calls } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    await getLatestAnalysis(client, "attacker-user", "victim-resume-id");

    expect(calls).toContainEqual({ method: "eq", args: ["resume_id", "victim-resume-id"] });
    expect(calls).toContainEqual({ method: "eq", args: ["user_id", "attacker-user"] });
  });

  it("orders by created_at desc and limits to 1, so the most recent analysis wins", async () => {
    const { builder, calls } = makeQueryBuilder({ data: ANALYSIS_ROW, error: null });
    const client = makeClient(builder);

    await getLatestAnalysis(client, "user-1", "resume-1");

    expect(calls).toContainEqual({
      method: "order",
      args: ["created_at", { ascending: false }],
    });
    expect(calls).toContainEqual({ method: "limit", args: [1] });
  });

  it("returns null (not an error) when no analysis exists yet — caller turns this into 404", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    const result = await getLatestAnalysis(client, "user-1", "resume-1");
    expect(result).toBeNull();
  });

  it("returns null when the resume belongs to someone else, never leaking the row", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    const result = await getLatestAnalysis(client, "attacker-user", "victim-resume-id");
    expect(result).toBeNull();
  });

  it("returns the most recent row when one exists", async () => {
    const { builder } = makeQueryBuilder({ data: ANALYSIS_ROW, error: null });
    const client = makeClient(builder);

    const result = await getLatestAnalysis(client, "user-1", "resume-1");
    expect(result).toEqual(ANALYSIS_ROW);
  });

  it("throws AnalysisQueryError on a Postgres error instead of silently returning a row", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { message: "connection reset" },
    });
    const client = makeClient(builder);

    await expect(getLatestAnalysis(client, "user-1", "resume-1")).rejects.toThrow(
      AnalysisQueryError,
    );
  });
});

describe("createAnalysis", () => {
  it("inserts with the caller-supplied user_id (never trusting a client-provided owner) and the validated Claude result", async () => {
    const { builder, calls } = makeQueryBuilder({ data: ANALYSIS_ROW, error: null });
    const client = makeClient(builder);

    const result = await createAnalysis(client, {
      resumeId: "resume-1",
      userId: "user-1",
      model: "claude-sonnet-5",
      result: {
        strengths: [{ label: "Strong backend", detail: "5 years Node.js" }],
        weaknesses: [{ label: "Limited frontend", detail: "No React experience" }],
        summary: "Solid backend engineer.",
        suggested_roles: ["Backend Engineer"],
      },
    });

    expect(result).toEqual(ANALYSIS_ROW);
    const insertCall = calls.find((c) => c.method === "insert");
    const inserted = insertCall?.args[0] as { user_id: string; resume_id: string };
    expect(inserted.user_id).toBe("user-1");
    expect(inserted.resume_id).toBe("resume-1");
  });

  it("throws AnalysisQueryError when no row is returned", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    await expect(
      createAnalysis(client, {
        resumeId: "resume-1",
        userId: "user-1",
        model: "claude-sonnet-5",
        result: { strengths: [], weaknesses: [], summary: "x", suggested_roles: [] },
      }),
    ).rejects.toThrow(AnalysisQueryError);
  });

  it("throws AnalysisQueryError on a Postgres error", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { message: "insert failed" },
    });
    const client = makeClient(builder);

    await expect(
      createAnalysis(client, {
        resumeId: "resume-1",
        userId: "user-1",
        model: "claude-sonnet-5",
        result: { strengths: [], weaknesses: [], summary: "x", suggested_roles: [] },
      }),
    ).rejects.toThrow(AnalysisQueryError);
  });
});
