import { describe, expect, it, vi } from "vitest";

import {
  CritiqueQueryError,
  getLatestCritique,
  getStandaloneCritique,
  insertResumeCritique,
  refundCritiqueCharge,
  STANDALONE_CRITIQUE_KEY,
} from "@/lib/supabase/queries/critiques";
import type { CritiqueResumeValue } from "@/lib/claude/tasks/critiqueResume";

/**
 * lib/supabase/queries/critiques.ts (§13.20.5): exact PostgREST calls, the
 * user_id filter on every admin query (§13.15 item 3), and error mapping.
 */

type Call = [string, ...unknown[]];

/** A chainable PostgREST builder stand-in that records every call and resolves to `result`. */
function recorder(result: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "insert", "update", "eq", "is", "order", "limit"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  builder.single = async () => {
    calls.push(["single"]);
    return result;
  };
  builder.maybeSingle = async () => {
    calls.push(["maybeSingle"]);
    return result;
  };
  builder.then = (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  const from = vi.fn(() => builder);
  return { client: { from } as never, from, calls };
}

const value: CritiqueResumeValue = {
  overall_score: 71,
  summary: "s",
  student_context: { stage: "late_student", note: "n" },
  dimensions: [{ dimension: "impact", score: 58, rationale: "r", top_fix: "f" }],
  line_feedback: [
    {
      section: "experience",
      original_text: "40 m²",
      issue_types: ["no_metric"],
      feedback: "f",
      suggested_rewrite: "w [X%]",
      needs_user_input: true,
    },
  ],
  section_feedback: [{ section: "S", feedback: "f" }],
  ats_issues: [{ issue: "i", fix: "x" }],
  missing_sections: ["Projects"],
};

describe("getLatestCritique (session client)", () => {
  it("reads the newest critique for the resume, any prompt version", async () => {
    const row = { id: "c1" };
    const { client, from, calls } = recorder({ data: row, error: null });
    await expect(getLatestCritique(client, "r1")).resolves.toBe(row);
    expect(from).toHaveBeenCalledWith("resume_critiques");
    expect(calls).toEqual([
      ["select", "*"],
      ["eq", "resume_id", "r1"],
      ["order", "created_at", { ascending: false }],
      ["limit", 1],
      ["maybeSingle"],
    ]);
  });

  it("returns null when there is none", async () => {
    const { client } = recorder({ data: null, error: null });
    await expect(getLatestCritique(client, "r1")).resolves.toBeNull();
  });

  it("throws CritiqueQueryError on failure", async () => {
    const { client } = recorder({ data: null, error: { code: "57014", message: "timeout" } });
    await expect(getLatestCritique(client, "r1")).rejects.toThrow(/get_latest_critique failed \(57014\)/);
  });
});

describe("getStandaloneCritique (session client)", () => {
  it("filters on resume, prompt version and report_id is null (the cache key)", async () => {
    const { client, calls } = recorder({ data: null, error: null });
    await expect(getStandaloneCritique(client, "r1", "critique-v1")).resolves.toBeNull();
    expect(calls).toEqual([
      ["select", "*"],
      ["eq", "resume_id", "r1"],
      ["eq", "prompt_version", "critique-v1"],
      ["is", "report_id", null],
      ["maybeSingle"],
    ]);
  });

  it("throws CritiqueQueryError on failure", async () => {
    const { client } = recorder({ data: null, error: { message: "boom" } });
    await expect(getStandaloneCritique(client, "r1", "v")).rejects.toBeInstanceOf(CritiqueQueryError);
  });
});

describe("insertResumeCritique (admin client)", () => {
  it("inserts every column with the given id and session user id, standalone (no report/profile)", async () => {
    const row = { id: "c1" };
    const { client, from, calls } = recorder({ data: row, error: null });
    await expect(
      insertResumeCritique(client, {
        id: "c1",
        userId: "u1",
        resumeId: "r1",
        promptVersion: "critique-v1",
        model: "claude-opus-5-5",
        value,
        droppedItems: 2,
      }),
    ).resolves.toBe(row);
    expect(from).toHaveBeenCalledWith("resume_critiques");
    expect(calls[0]).toEqual([
      "insert",
      {
        id: "c1",
        user_id: "u1",
        resume_id: "r1",
        report_id: null,
        profile_id: null,
        prompt_version: "critique-v1",
        model: "claude-opus-5-5",
        overall_score: 71,
        summary: "s",
        student_context: value.student_context,
        dimension_scores: value.dimensions,
        line_feedback: value.line_feedback,
        section_feedback: value.section_feedback,
        ats_issues: value.ats_issues,
        missing_sections: value.missing_sections,
        dropped_items: 2,
      },
    ]);
    expect(calls.slice(1)).toEqual([["select", "*"], ["single"]]);
  });

  it("flags a unique violation on the standalone cache key as isStandaloneConflict", async () => {
    const { client } = recorder({
      data: null,
      error: {
        code: "23505",
        message: `duplicate key value violates unique constraint "${STANDALONE_CRITIQUE_KEY}"`,
        details: "Key (resume_id, prompt_version)=(r1, critique-v1) already exists.",
      },
    });
    const err = await insertResumeCritique(client, {
      id: "c1",
      userId: "u1",
      resumeId: "r1",
      promptVersion: "critique-v1",
      model: "m",
      value,
      droppedItems: 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CritiqueQueryError);
    expect(err).toMatchObject({ code: "23505", isStandaloneConflict: true });
  });

  it.each([
    ["another unique violation (primary key)", { code: "23505", message: 'duplicate key value violates unique constraint "resume_critiques_pkey"' }],
    ["the same-owner trigger", { code: "P0001", message: "validation_owner_mismatch" }],
    ["a missing row", null],
  ])("%s is not a standalone conflict", async (_label, error) => {
    const { client } = recorder({ data: null, error });
    const err = await insertResumeCritique(client, {
      id: "c1",
      userId: "u1",
      resumeId: "r1",
      promptVersion: "v",
      model: "m",
      value,
      droppedItems: 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CritiqueQueryError);
    expect(err).toMatchObject({ isStandaloneConflict: false });
  });
});

describe("refundCritiqueCharge (admin client)", () => {
  it("sets refunded_at on the session user's unrefunded resume_report row for this critique", async () => {
    const now = new Date("2026-11-17T12:00:00.000Z");
    const { client, from, calls } = recorder({ data: [{ id: "e1" }], error: null });
    await expect(refundCritiqueCharge(client, "u1", "c1", now)).resolves.toBe(1);
    expect(from).toHaveBeenCalledWith("rate_limit_events");
    expect(calls).toEqual([
      ["update", { refunded_at: "2026-11-17T12:00:00.000Z" }],
      ["eq", "ref_id", "c1"],
      ["eq", "user_id", "u1"],
      ["eq", "kind", "resume_report"],
      ["is", "refunded_at", null],
      ["select", "id"],
    ]);
  });

  it("returns 0 when nothing was left to refund (idempotent)", async () => {
    const { client } = recorder({ data: [], error: null });
    await expect(refundCritiqueCharge(client, "u1", "c1")).resolves.toBe(0);
  });

  it("throws CritiqueQueryError on failure", async () => {
    const { client } = recorder({ data: null, error: { code: "42501", message: "denied" } });
    await expect(refundCritiqueCharge(client, "u1", "c1")).rejects.toThrow(/refund_critique_charge failed/);
  });
});
