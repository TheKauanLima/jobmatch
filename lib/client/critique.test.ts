import { describe, expect, it, vi } from "vitest";

import {
  budgetExhaustedMessage,
  clampScore,
  CRITIQUE_COPY,
  DIMENSION_LABELS,
  dimensionLabel,
  formatCritiqueDate,
  formatElapsed,
  groupLineFeedback,
  interpretCritiqueLoad,
  interpretCritiqueResponse,
  ISSUE_TYPE_LABELS,
  issueTypeLabel,
  outcomeToRunResult,
  rateLimitedMessage,
  requestCritiqueRun,
  scoreBand,
  SECTION_LABELS,
  sectionLabel,
  splitPlaceholders,
  STUDENT_STAGE_LABELS,
  studentStageLabel,
  type CritiqueRunOutcome,
} from "@/lib/client/critique";
import { formatLocalDateTime } from "@/lib/client/formatDateTime";
import {
  CRITIQUE_DIMENSION_ORDER,
  CRITIQUE_ISSUE_TYPES,
  CRITIQUE_SECTIONS,
  CRITIQUE_STUDENT_STAGES,
} from "@/types/domain";
import { sampleCritique } from "@/tests/fixtures/resumes/critiqueView";

const RESUME_ID = "11111111-1111-4111-8111-111111111111";
const RETRY_AFTER = "2026-11-18T00:00:00.000Z";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function run(response: Response) {
  return outcomeToRunResult(await interpretCritiqueResponse(response));
}

describe("labels", () => {
  it("uses the binding §13.20.6 dimension labels", () => {
    expect(DIMENSION_LABELS).toEqual({
      impact: "Impact & results",
      clarity: "Clarity",
      relevance: "Relevance",
      structure: "Structure & formatting",
      ats_readability: "ATS readability",
    });
  });

  it("has a label for every enum value in types/domain.ts", () => {
    for (const key of CRITIQUE_DIMENSION_ORDER) expect(DIMENSION_LABELS[key]).toBeTruthy();
    for (const key of CRITIQUE_ISSUE_TYPES) expect(ISSUE_TYPE_LABELS[key]).toBeTruthy();
    for (const key of CRITIQUE_SECTIONS) expect(SECTION_LABELS[key]).toBeTruthy();
    for (const key of CRITIQUE_STUDENT_STAGES) expect(STUDENT_STAGE_LABELS[key]).toBeTruthy();
  });

  it("looks up known keys", () => {
    expect(dimensionLabel("ats_readability")).toBe("ATS readability");
    expect(issueTypeLabel("no_metric")).toBe("No measurable result");
    expect(sectionLabel("leadership")).toBe("Leadership & activities");
    expect(studentStageLabel("new_grad")).toBe("New graduate");
  });

  it("humanizes unknown keys instead of rendering undefined", () => {
    expect(dimensionLabel("some_new_dimension")).toBe("Some new dimension");
    expect(issueTypeLabel("buzzword")).toBe("Buzzword");
    expect(sectionLabel("")).toBe("");
  });

  it("does not resolve inherited object keys", () => {
    expect(issueTypeLabel("toString")).toBe("ToString");
    expect(sectionLabel("constructor")).toBe("Constructor");
  });
});

describe("scoreBand (§13.20.6)", () => {
  it.each([
    [100, "strong", "Strong"],
    [75, "strong", "Strong"],
    [74, "polish", "Needs polish"],
    [50, "polish", "Needs polish"],
    [49, "work", "Needs work"],
    [0, "work", "Needs work"],
  ])("%i → %s", (score, key, label) => {
    expect(scoreBand(score)).toEqual({ key, label });
  });

  it("clamps scores for drawing only", () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(140)).toBe(100);
    expect(clampScore(63)).toBe(63);
    expect(clampScore(Number.NaN)).toBe(0);
  });
});

describe("splitPlaceholders", () => {
  it("marks bracketed placeholders and keeps the rest as plain text", () => {
    expect(splitPlaceholders("Cut costs by [X%] across [N] sites")).toEqual([
      { text: "Cut costs by ", placeholder: false },
      { text: "[X%]", placeholder: true },
      { text: " across ", placeholder: false },
      { text: "[N]", placeholder: true },
      { text: " sites", placeholder: false },
    ]);
  });

  it("handles placeholders at the edges and adjacent ones", () => {
    expect(splitPlaceholders("[A][B]")).toEqual([
      { text: "[A]", placeholder: true },
      { text: "[B]", placeholder: true },
    ]);
  });

  it("returns one plain segment when there are no placeholders", () => {
    expect(splitPlaceholders("Led a team of 4")).toEqual([
      { text: "Led a team of 4", placeholder: false },
    ]);
    expect(splitPlaceholders("")).toEqual([]);
  });

  it("leaves unmatched or empty brackets as plain text", () => {
    expect(splitPlaceholders("a [b and [] c")).toEqual([
      { text: "a [b and [] c", placeholder: false },
    ]);
  });

  it("keeps markup-looking text as literal characters", () => {
    const segments = splitPlaceholders("<b>[X]</b>");
    expect(segments.map((s) => s.text).join("")).toBe("<b>[X]</b>");
    expect(segments[1]).toEqual({ text: "[X]", placeholder: true });
  });

  it("preserves non-ASCII characters exactly", () => {
    const text = "Audited 40,000 m² in SolidWorks™ for [N] sites";
    expect(splitPlaceholders(text).map((s) => s.text).join("")).toBe(text);
  });
});

describe("groupLineFeedback", () => {
  it("groups by section in order of first appearance, keeping item order", () => {
    const groups = groupLineFeedback(sampleCritique().line_feedback);
    expect(groups.map((g) => g.section)).toEqual([
      "experience",
      "projects",
      "skills",
      "summary",
    ]);
    expect(groups[0].label).toBe("Experience");
    expect(groups[0].items.map((i) => i.id)).toEqual(["lf_0", "lf_1", "lf_3"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["lf_2", "lf_4"]);
  });

  it("returns no groups for no items", () => {
    expect(groupLineFeedback([])).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats the critique date in UTC, deterministically", () => {
    expect(formatCritiqueDate("2026-11-17T15:04:05.000Z")).toBe("Nov 17, 2026");
    // Late UTC evening stays on the UTC date regardless of server zone.
    expect(formatCritiqueDate("2026-11-17T23:59:59.000Z")).toBe("Nov 17, 2026");
    expect(formatCritiqueDate("not a date")).toBeNull();
  });

  it.each([
    [0, "0:00"],
    [7.9, "0:07"],
    [65, "1:05"],
    [725, "12:05"],
    [-3, "0:00"],
  ])("formatElapsed(%d) → %s", (seconds, text) => {
    expect(formatElapsed(seconds)).toBe(text);
  });
});

describe("requestCritiqueRun request", () => {
  it("POSTs to the resume's critique route with no body and no caching", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(201, { critique: {} }));
    expect(await requestCritiqueRun(RESUME_ID, fetchImpl)).toEqual({ kind: "ok", created: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`/api/resumes/${RESUME_ID}/critique`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(init?.cache).toBe("no-store");
  });

  it("encodes the resume id into the path", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, {}));
    await requestCritiqueRun("a/b?c", fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/resumes/a%2Fb%3Fc/critique");
  });

  it("maps a network failure to uncertain and never throws", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await requestCritiqueRun(RESUME_ID, fetchImpl)).toEqual({ kind: "uncertain" });
  });
});

describe("POST response mapping (§13.20.4)", () => {
  it("201 (new) and 200 (cached / race winner) both refresh the page", async () => {
    expect(await interpretCritiqueResponse(jsonResponse(201, { critique: {} }))).toEqual({
      kind: "ok",
      created: true,
    });
    expect(await interpretCritiqueResponse(jsonResponse(200, { critique: {} }))).toEqual({
      kind: "ok",
      created: false,
    });
    expect(await run(jsonResponse(201, {}))).toEqual({ type: "refresh" });
    expect(await run(new Response("", { status: 200 }))).toEqual({ type: "refresh" });
  });

  it("401 → session ended, with a login link", async () => {
    expect(await run(jsonResponse(401, { error: "Unauthorized" }))).toEqual({
      type: "error",
      message: CRITIQUE_COPY.unauthorized,
      showLogin: true,
      showRefresh: false,
    });
  });

  it("404 not_found → resume missing", async () => {
    const result = await run(jsonResponse(404, { error: "Not found.", code: "not_found" }));
    expect(result).toMatchObject({ type: "error", message: CRITIQUE_COPY.notFound });
  });

  it("422 text_extraction_failed → §13.13.9 copy", async () => {
    const result = await run(
      jsonResponse(422, { error: "x", code: "text_extraction_failed" }),
    );
    expect(result).toMatchObject({
      type: "error",
      message:
        "We couldn't read text from this file. Try a PDF exported from your editor, or a DOCX.",
      showRefresh: false,
    });
  });

  it("429 rate_limited → reset time in the viewer's local zone", async () => {
    const outcome = await interpretCritiqueResponse(
      jsonResponse(429, {
        error: "x",
        code: "rate_limited",
        kind: "resume_report",
        retry_after: RETRY_AFTER,
      }),
    );
    expect(outcome).toEqual({ kind: "rate_limited", retryAfter: RETRY_AFTER });
    const result = outcomeToRunResult(outcome);
    const when = formatLocalDateTime(RETRY_AFTER);
    expect(when).toBeTruthy();
    expect(result).toMatchObject({
      type: "error",
      message: `You've used all of today's resume reports. You can run another after ${when}.`,
    });
  });

  it("429 without a usable retry_after falls back to 00:00 UTC copy", async () => {
    expect(await run(jsonResponse(429, { code: "rate_limited" }))).toMatchObject({
      message: CRITIQUE_COPY.rateLimitedFallback,
    });
    expect(await run(new Response("Too Many Requests", { status: 429 }))).toMatchObject({
      message: CRITIQUE_COPY.rateLimitedFallback,
    });
    expect(rateLimitedMessage("garbage")).toBe(CRITIQUE_COPY.rateLimitedFallback);
  });

  it("503 budget_exhausted → capacity copy with local reset time", async () => {
    const outcome = await interpretCritiqueResponse(
      jsonResponse(503, { error: "x", code: "budget_exhausted", retry_after: RETRY_AFTER }),
    );
    expect(outcome).toEqual({ kind: "budget_exhausted", retryAfter: RETRY_AFTER });
    expect(outcomeToRunResult(outcome)).toMatchObject({
      message: `Kalify's AI features have reached today's capacity. Try again after ${formatLocalDateTime(RETRY_AFTER)}.`,
    });
    expect(budgetExhaustedMessage(null)).toBe(
      "Kalify's AI features have reached today's capacity. Try again after 00:00 UTC.",
    );
  });

  it("a platform 503 without our code is uncertain, not budget", async () => {
    expect(await interpretCritiqueResponse(new Response("Service Unavailable", { status: 503 }))).toEqual({
      kind: "uncertain",
    });
  });

  it("502 ai_unavailable and 500 internal_error → system copy (refunded)", async () => {
    for (const response of [
      jsonResponse(502, { code: "ai_unavailable" }),
      jsonResponse(500, { code: "internal_error" }),
    ]) {
      expect(await run(response)).toEqual({
        type: "error",
        message:
          "Something went wrong on our side. Retry, and this one won't count toward your daily limit.",
        showLogin: false,
        showRefresh: false,
      });
    }
  });

  it.each(["ai_refused", "ai_invalid_output", "ai_truncated", "ai_bad_request"])(
    "502 %s → model copy, with no refund promise",
    async (code) => {
      const result = await run(jsonResponse(502, { code }));
      expect(result).toMatchObject({ type: "error", message: CRITIQUE_COPY.modelError });
      if (result.type === "error") expect(result.message).not.toContain("won't count");
    },
  );

  it("gateway errors without our JSON (502/504/500 HTML) → uncertain with a refresh action", async () => {
    for (const response of [
      new Response("<html>Bad Gateway</html>", { status: 502 }),
      new Response("<html>Gateway Timeout</html>", { status: 504 }),
      new Response("FUNCTION_INVOCATION_FAILED", { status: 500 }),
      jsonResponse(422, { code: "something_else" }),
      jsonResponse(418, {}),
    ]) {
      expect(await run(response)).toEqual({
        type: "error",
        message: CRITIQUE_COPY.uncertain,
        showLogin: false,
        showRefresh: true,
      });
    }
  });

  it("every outcome maps to a result (exhaustive)", () => {
    const outcomes: CritiqueRunOutcome[] = [
      { kind: "ok", created: true },
      { kind: "unauthorized" },
      { kind: "not_found" },
      { kind: "text_extraction_failed" },
      { kind: "rate_limited", retryAfter: null },
      { kind: "budget_exhausted", retryAfter: null },
      { kind: "system_error" },
      { kind: "model_error" },
      { kind: "uncertain" },
    ];
    for (const outcome of outcomes) {
      const result = outcomeToRunResult(outcome);
      if (result.type === "error") expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe("GET response mapping (page load)", () => {
  it("200 with a critique → ok", async () => {
    const critique = sampleCritique();
    expect(await interpretCritiqueLoad(jsonResponse(200, { critique }))).toEqual({
      kind: "ok",
      critique,
    });
  });

  it("200 with a malformed body → error", async () => {
    expect(await interpretCritiqueLoad(jsonResponse(200, { critique: { id: "x" } }))).toEqual({
      kind: "error",
    });
    expect(await interpretCritiqueLoad(new Response("nope", { status: 200 }))).toEqual({
      kind: "error",
    });
  });

  it("404 no_critique → empty state", async () => {
    expect(
      await interpretCritiqueLoad(jsonResponse(404, { error: "x", code: "no_critique" })),
    ).toEqual({ kind: "none" });
  });

  it("404 not_found, 401 and 500 → error", async () => {
    for (const response of [
      jsonResponse(404, { code: "not_found" }),
      jsonResponse(401, { error: "Unauthorized" }),
      jsonResponse(500, { code: "internal_error" }),
    ]) {
      expect(await interpretCritiqueLoad(response)).toEqual({ kind: "error" });
    }
  });
});
