import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeCritiqueDb, type FakeCritiqueDb } from "@/tests/fakes/critiqueDb";
import { critiqueOutput, UNICODE_RESUME } from "@/tests/fixtures/resumes/critique";

const { state, mockRequireSession, mockRunCritique, mockDownload, mockExtract } = vi.hoisted(() => ({
  state: { db: null as unknown as FakeCritiqueDb, userId: "" },
  mockRequireSession: vi.fn(),
  mockRunCritique: vi.fn(),
  mockDownload: vi.fn(),
  mockExtract: vi.fn(),
}));

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return { ...actual, requireSession: mockRequireSession };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.db.session(state.userId),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => state.db.admin(),
}));

vi.mock("@/lib/claude/tasks/critiqueResume", async () => {
  const actual = await vi.importActual<typeof import("@/lib/claude/tasks/critiqueResume")>(
    "@/lib/claude/tasks/critiqueResume",
  );
  return { ...actual, runCritiqueResume: mockRunCritique };
});

vi.mock("@/lib/storage/resumeFiles", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storage/resumeFiles")>(
    "@/lib/storage/resumeFiles",
  );
  return { ...actual, downloadResumeFile: mockDownload, extractResumeText: mockExtract };
});

const routeModule = await import("@/app/api/resumes/[id]/critique/route");
const { GET, POST } = routeModule;
const { UnauthorizedError } = await import("@/lib/auth/session");
const { validateCritiqueResume } = await import("@/lib/claude/tasks/critiqueResume");
const { ClaudeApiError, ClaudeRefusalError } = await import("@/lib/claude/errors");
const { SYNC_ROUTE_CLAUDE_DEADLINE_MS } = await import("@/lib/claude/config");
const { recordAiUsageEvent } = await import("@/lib/tasks/usageSink");

/**
 * GET/POST /api/resumes/:id/critique (docs/ARCHITECTURE.md §13.20.4; ROADMAP
 * V1.1 acceptance). The real service and query modules run against the
 * in-memory database (tests/fakes/critiqueDb.ts); only auth, Claude and
 * Storage are mocked.
 */

const USER_ID = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER_ID = "bbbbbbbb-0000-4000-8000-00000000000b";
const RESUME_ID = "11111111-1111-4111-8111-111111111111";

function outcome() {
  const { value, dropped } = validateCritiqueResume(critiqueOutput(), { sourceText: UNICODE_RESUME });
  return {
    value,
    dropped,
    model: "claude-opus-5-5",
    usage: { inputTokens: 5000, outputTokens: 9000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2, priceKnown: true },
    requestId: "req_1",
  };
}

const request = (method: "GET" | "POST") =>
  new Request(`http://localhost/api/resumes/${RESUME_ID}/critique`, { method });
const context = (id = RESUME_ID) => ({ params: Promise.resolve({ id }) });
const post = (id?: string) => POST(request("POST"), context(id));
const get = (id?: string) => GET(request("GET"), context(id));

let db: FakeCritiqueDb;

function signIn(userId: string) {
  state.userId = userId;
  mockRequireSession.mockResolvedValue({ user: { id: userId }, session: {} });
}

beforeEach(() => {
  db = createFakeCritiqueDb();
  state.db = db;
  db.addResume({ id: RESUME_ID, user_id: USER_ID, extracted_text: UNICODE_RESUME });
  signIn(USER_ID);
  mockRunCritique.mockReset().mockResolvedValue(outcome());
  mockDownload.mockReset();
  mockExtract.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  delete process.env.GLOBAL_DAILY_AI_BUDGET_USD;
});

describe("route config", () => {
  it("exports maxDuration = 300 (above the 270 s Claude deadline)", () => {
    expect(routeModule.maxDuration).toBe(300);
    expect(SYNC_ROUTE_CLAUDE_DEADLINE_MS).toBe(270_000);
  });

  it("registers the usage sink (imports lib/tasks/registerUsageSink)", () => {
    // lib/claude/usage.ts keeps the process-wide sink under this registry symbol.
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("kalify.claude.usageSink")]).toBe(recordAiUsageEvent);
  });
});

describe("POST /api/resumes/:id/critique", () => {
  it("401 without a session, before touching the database", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const res = await post();
    expect(res.status).toBe(401);
    expect(db.calls).toHaveLength(0);
  });

  it("201 on a fresh resume: 5 dimensions in fixed order, 3 priorities, overall = rounded mean", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const { critique } = await res.json();
    expect(critique.dimensions.map((d: { dimension: string }) => d.dimension)).toEqual([
      "impact",
      "clarity",
      "relevance",
      "structure",
      "ats_readability",
    ]);
    expect(critique.priorities).toHaveLength(3);
    const scores = critique.dimensions.map((d: { score: number }) => d.score);
    expect(critique.overall_score).toBe(Math.round(scores.reduce((a: number, b: number) => a + b, 0) / 5));
    expect(critique.line_feedback[0].id).toBe("lf_0");
    expect(critique).not.toHaveProperty("user_id");
    expect(critique).not.toHaveProperty("dropped_items");
  });

  it("passes the 270 s deadline signal to the Claude run", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await post();
    expect(timeout).toHaveBeenCalledWith(SYNC_ROUTE_CLAUDE_DEADLINE_MS);
    const [, ctx] = mockRunCritique.mock.calls[0];
    expect(ctx.signal).toBe(timeout.mock.results[0].value);
    expect(ctx.userId).toBe(USER_ID);
  });

  it("a second POST returns 200 with the same id, no Claude call and no new rate_limit_events row", async () => {
    const first = await (await post()).json();
    const eventsBefore = db.tables.rate_limit_events.length;
    mockRunCritique.mockClear();

    const res = await post();
    expect(res.status).toBe(200);
    const second = await res.json();
    expect(second.critique.id).toBe(first.critique.id);
    expect(mockRunCritique).not.toHaveBeenCalled();
    expect(db.tables.rate_limit_events).toHaveLength(eventsBefore);
  });

  it("404 not_found for another user's resume (no charge)", async () => {
    signIn(OTHER_ID);
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
    expect(db.tables.rate_limit_events).toHaveLength(0);
  });

  it("404 not_found for a malformed id", async () => {
    db.failNext("session:resumes:select", { code: "22P02", message: "invalid input syntax for type uuid" });
    const res = await post("not-a-uuid");
    expect(res.status).toBe(404);
  });

  it("422 text_extraction_failed with no charge", async () => {
    db.tables.resumes[0].extracted_text = null;
    mockDownload.mockResolvedValue(Buffer.from("x"));
    mockExtract.mockResolvedValue("");
    const res = await post();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "text_extraction_failed" });
    expect(db.tables.rate_limit_events).toHaveLength(0);
    expect(mockRunCritique).not.toHaveBeenCalled();
  });

  it("429 rate_limited with kind resume_report and retry_after", async () => {
    for (let i = 0; i < 5; i += 1) {
      db.tables.rate_limit_events.push({ id: `e${i}`, user_id: USER_ID, kind: "resume_report", ref_id: null, refunded_at: null });
    }
    const res = await post();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({ code: "rate_limited", kind: "resume_report" });
    expect(body.retry_after).toMatch(/T00:00:00\.000Z$/);
    expect(mockRunCritique).not.toHaveBeenCalled();
  });

  it("503 budget_exhausted with retry_after and no charge", async () => {
    db.setSpendUsd(100);
    const res = await post();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "budget_exhausted",
      error: "Kalify's AI features have reached today's capacity. Try again after 00:00 UTC.",
    });
    expect(body.retry_after).toMatch(/T00:00:00\.000Z$/);
    expect(db.tables.rate_limit_events).toHaveLength(0);
    expect(mockRunCritique).not.toHaveBeenCalled();
  });

  it("502 ai_unavailable (e.g. the deadline) refunds the charge", async () => {
    mockRunCritique.mockRejectedValue(new ClaudeApiError("aborted", { code: "ai_unavailable", retryable: true }));
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "ai_unavailable" });
    expect(db.tables.rate_limit_events).toHaveLength(1);
    expect(db.tables.rate_limit_events[0].refunded_at).not.toBeNull();
  });

  it("502 ai_refused does not refund the charge", async () => {
    mockRunCritique.mockRejectedValue(new ClaudeRefusalError("refused", { category: null, requestId: null }));
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "ai_refused" });
    expect(db.tables.rate_limit_events).toHaveLength(1);
    expect(db.tables.rate_limit_events[0].refunded_at).toBeNull();
  });

  it("unique-violation race: returns the existing row with 200; the loser's charge stands (no refund)", async () => {
    mockRunCritique.mockImplementation(async () => {
      db.tables.resume_critiques.push({
        id: "winner",
        user_id: USER_ID,
        resume_id: RESUME_ID,
        report_id: null,
        profile_id: null,
        prompt_version: "critique-v1",
        model: "claude-opus-5-5",
        overall_score: 70,
        summary: "winner",
        student_context: { stage: "late_student", note: "n" },
        dimension_scores: outcome().value.dimensions,
        line_feedback: [],
        section_feedback: [],
        ats_issues: [],
        missing_sections: [],
        dropped_items: 0,
        created_at: "2026-11-17T00:00:00.000Z",
      });
      return outcome();
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).critique.id).toBe("winner");
    expect(db.tables.rate_limit_events).toHaveLength(1);
    expect(db.tables.rate_limit_events[0].refunded_at).toBeNull();
  });

  it("500 internal_error when the insert fails (refunded, so the copy says it won't count)", async () => {
    db.failNext("admin:resume_critiques:insert", { code: "57014", message: "timeout" });
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "internal_error", error: expect.stringContaining("won't count") });
    expect(db.tables.rate_limit_events[0].refunded_at).not.toBeNull();
  });

  it("502 ai_unavailable says it won't count only when the refund succeeded", async () => {
    mockRunCritique.mockRejectedValue(new ClaudeApiError("aborted", { code: "ai_unavailable", retryable: true }));
    expect((await (await post()).json()).error).toContain("won't count");

    db.tables.rate_limit_events.length = 0;
    db.failNext("admin:rate_limit_events:update", { code: "57014", message: "timeout" });
    const res = await post();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ code: "ai_unavailable", error: "Something went wrong on our side. Please try again." });
    expect(body.error).not.toContain("won't count");
  });

  it("500 before any charge (budget query error) uses the neutral copy", async () => {
    db.failNext("admin:rpc:ai_spend_summary", { code: "57014", message: "timeout" });
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain("won't count");
  });
});

describe("GET /api/resumes/:id/critique", () => {
  it("401 without a session", async () => {
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
  });

  it("404 not_found for another user's resume, even if a critique exists", async () => {
    await post();
    signIn(OTHER_ID);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  it("404 no_critique for an owned resume without one", async () => {
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "no_critique" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("200 with the latest critique (any prompt version), never calling Claude or charging", async () => {
    await post();
    db.tables.resume_critiques.push({
      ...db.tables.resume_critiques[0],
      id: "older",
      prompt_version: "critique-v0",
      created_at: "2020-01-01T00:00:00.000Z",
    });
    mockRunCritique.mockClear();
    const eventsBefore = db.tables.rate_limit_events.length;

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const { critique } = await res.json();
    expect(critique.id).not.toBe("older");
    expect(critique.is_current).toBe(true);
    expect(mockRunCritique).not.toHaveBeenCalled();
    expect(db.tables.rate_limit_events).toHaveLength(eventsBefore);
    expect(db.count("session:rpc:request_resume_critique")).toBe(1);
  });

  it("is_current is false for a critique from an older prompt version", async () => {
    db.tables.resume_critiques.push({
      id: "older",
      user_id: USER_ID,
      resume_id: RESUME_ID,
      report_id: null,
      prompt_version: "critique-v0",
      model: "m",
      overall_score: 50,
      summary: "s",
      student_context: { stage: "new_grad", note: "n" },
      dimension_scores: outcome().value.dimensions,
      line_feedback: [],
      section_feedback: [],
      ats_issues: [],
      missing_sections: [],
      created_at: "2026-11-01T00:00:00.000Z",
    });
    const { critique } = await (await get()).json();
    expect(critique).toMatchObject({ id: "older", is_current: false, prompt_version: "critique-v0" });
  });

  it("500 internal_error when the read fails", async () => {
    db.failNext("session:resume_critiques:select", { code: "57014", message: "timeout" });
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "internal_error" });
  });
});
