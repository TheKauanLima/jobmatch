import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { ClaudeInvalidOutputError } from "@/lib/claude/errors";
import {
  matchResultSchema,
  resumeAnalysisResultSchema,
  validateMatchResult,
  validateResumeAnalysis,
  type MatchResult,
  type ResumeAnalysisResult,
} from "@/lib/claude/parse";

/**
 * Coverage for the v1 output contracts and their semantic validation
 * (docs/ARCHITECTURE.md §13.5.2 / §13.5.6, M1.1). The forced-tool repair
 * logic these tests used to cover (`repairListField` and friends) was deleted
 * in M1.1, since structured outputs make the shape guaranteed.
 */

describe("v1 schemas (structure only)", () => {
  it("keep the v1 field names and order the UI/DB depend on", () => {
    expect(Object.keys(resumeAnalysisResultSchema.shape)).toEqual([
      "strengths",
      "weaknesses",
      "summary",
      "suggested_roles",
    ]);
    expect(Object.keys(matchResultSchema.shape)).toEqual([
      "score",
      "rationale",
      "matched_strengths",
      "gaps",
    ]);
  });

  it("convert to a strict structured-output JSON schema via zodOutputFormat", () => {
    const analysis = zodOutputFormat(resumeAnalysisResultSchema).schema;
    expect(analysis).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["strengths", "weaknesses", "summary", "suggested_roles"],
    });
    const match = zodOutputFormat(matchResultSchema).schema as {
      properties: { score: { type: string } };
    };
    expect(match.properties.score.type).toBe("integer");
  });

  it("reject wrong shapes (what callStructured relies on)", () => {
    expect(matchResultSchema.safeParse({ score: "80", rationale: "r", matched_strengths: [], gaps: [] }).success).toBe(false);
    expect(matchResultSchema.safeParse({ score: 80.5, rationale: "r", matched_strengths: [], gaps: [] }).success).toBe(false);
    expect(matchResultSchema.safeParse({ score: 80, rationale: "r", matched_strengths: "a, b", gaps: [] }).success).toBe(false);
    expect(matchResultSchema.safeParse({ score: 80, rationale: "r", matched_strengths: [] }).success).toBe(false);
    expect(resumeAnalysisResultSchema.safeParse({ strengths: [{ label: "x" }], weaknesses: [], summary: "s", suggested_roles: [] }).success).toBe(false);
  });
});

describe("validateResumeAnalysis", () => {
  const good: ResumeAnalysisResult = {
    strengths: [{ label: " Backend ", detail: " 5 years Node.js " }],
    weaknesses: [{ label: "Testing", detail: "Little test coverage mentioned." }],
    summary: " Solid engineer. ",
    suggested_roles: [" Backend Engineer "],
  };

  it("returns trimmed values and zero drops for a clean output", () => {
    expect(validateResumeAnalysis(good)).toEqual({
      value: {
        strengths: [{ label: "Backend", detail: "5 years Node.js" }],
        weaknesses: [{ label: "Testing", detail: "Little test coverage mentioned." }],
        summary: "Solid engineer.",
        suggested_roles: ["Backend Engineer"],
      },
      dropped: 0,
    });
  });

  it("drops items with an empty label or detail, and empty roles, counting them", () => {
    const result = validateResumeAnalysis({
      ...good,
      strengths: [...good.strengths, { label: " ", detail: "x" }],
      weaknesses: [{ label: "x", detail: "" }],
      suggested_roles: ["", "Engineer", "  "],
    });
    expect(result.value.strengths).toHaveLength(1);
    expect(result.value.weaknesses).toEqual([]);
    expect(result.value.suggested_roles).toEqual(["Engineer"]);
    expect(result.dropped).toBe(4);
  });

  it("allows empty lists (as in v1)", () => {
    expect(() =>
      validateResumeAnalysis({ strengths: [], weaknesses: [], summary: "s", suggested_roles: [] }),
    ).not.toThrow();
  });

  it("rejects an empty summary as invalid output", () => {
    expect(() => validateResumeAnalysis({ ...good, summary: "  " })).toThrow(ClaudeInvalidOutputError);
  });
});

describe("validateMatchResult", () => {
  const good: MatchResult = {
    score: 82,
    rationale: " Strong overlap. ",
    matched_strengths: [" Node.js ", ""],
    gaps: ["No AWS"],
  };

  it("returns trimmed values and counts dropped empty entries", () => {
    expect(validateMatchResult(good)).toEqual({
      value: { score: 82, rationale: "Strong overlap.", matched_strengths: ["Node.js"], gaps: ["No AWS"] },
      dropped: 1,
    });
  });

  it.each([0, 100])("accepts boundary score %i", (score) => {
    expect(validateMatchResult({ ...good, score }).value.score).toBe(score);
  });

  it.each([-1, 101, 1000, 55.5, Number.NaN])("rejects score %d (never clamps)", (score) => {
    expect(() => validateMatchResult({ ...good, score })).toThrow(ClaudeInvalidOutputError);
  });

  it("rejects an empty rationale", () => {
    expect(() => validateMatchResult({ ...good, rationale: "" })).toThrow(ClaudeInvalidOutputError);
  });

  it("allows empty strengths and gaps", () => {
    expect(validateMatchResult({ ...good, matched_strengths: [], gaps: [] }).dropped).toBe(0);
  });
});
