import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeCritiqueDb, type FakeCritiqueDb } from "@/tests/fakes/critiqueDb";
import { critiqueOutput, ORIGINAL_SPANS, UNICODE_RESUME } from "@/tests/fixtures/resumes/critique";
import { importsOf, isTestFile, REPO_ROOT, repoSourceFiles } from "@/tests/helpers/sdkImports";

const { state, mockRunCritique, mockDownload, mockExtract } = vi.hoisted(() => ({
  state: { db: null as unknown as FakeCritiqueDb },
  mockRunCritique: vi.fn(),
  mockDownload: vi.fn(),
  mockExtract: vi.fn(),
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

const { requestCritique } = await import("@/lib/critique/service");
const { validateCritiqueResume } = await import("@/lib/claude/tasks/critiqueResume");
const {
  ClaudeApiError,
  ClaudeBadRequestError,
  ClaudeInvalidOutputError,
  ClaudeRefusalError,
  ClaudeTruncatedError,
} = await import("@/lib/claude/errors");
const { ResumeStorageError, ResumeTextExtractionError } = await import("@/lib/storage/resumeFiles");

/**
 * lib/critique/service.ts (docs/ARCHITECTURE.md §13.20.4 steps 2-9) against
 * an in-memory database that models RLS, the charge RPC, the cache key and
 * the same-owner trigger (tests/fakes/critiqueDb.ts). Claude and Storage are
 * mocked.
 */

const USER = { id: "aaaaaaaa-0000-4000-8000-00000000000a" };
const OTHER = { id: "bbbbbbbb-0000-4000-8000-00000000000b" };
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

const signal = new AbortController().signal;
const run = (user = USER, resumeId = RESUME_ID) =>
  requestCritique(state.db.session(user.id), user, resumeId, signal);

let db: FakeCritiqueDb;
let logs: string[];

beforeEach(() => {
  db = createFakeCritiqueDb();
  state.db = db;
  db.addResume({ id: RESUME_ID, user_id: USER.id, extracted_text: UNICODE_RESUME });
  mockRunCritique.mockReset().mockResolvedValue(outcome());
  mockDownload.mockReset();
  mockExtract.mockReset();
  logs = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
  delete process.env.GLOBAL_DAILY_AI_BUDGET_USD;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GLOBAL_DAILY_AI_BUDGET_USD;
});

function chargeFor(critiqueId: string) {
  return db.tables.rate_limit_events.find((e) => e.ref_id === critiqueId);
}

describe("requestCritique: success and cache", () => {
  it("runs, charges once and stores a fresh critique (201)", async () => {
    const result = await run();
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.status).toBe(201);

    const { critique } = result;
    expect(critique.dimensions.map((d) => d.dimension)).toEqual([
      "impact",
      "clarity",
      "relevance",
      "structure",
      "ats_readability",
    ]);
    expect(critique.overall_score).toBe(
      Math.round(critique.dimensions.reduce((s, d) => s + d.score, 0) / 5),
    );
    expect(critique.priorities.map((p) => [p.dimension, p.score])).toEqual([
      ["impact", 58],
      ["clarity", 66],
      ["ats_readability", 72],
    ]);
    expect(critique.prompt_version).toBe("critique-v1");
    expect(critique.is_current).toBe(true);
    expect(critique.line_feedback[0]).toMatchObject({ id: "lf_0", original_text: ORIGINAL_SPANS.hvac });

    // Stored with id = the charge's ref_id, owned by the session user.
    const row = db.tables.resume_critiques[0];
    expect(row).toMatchObject({ id: critique.id, user_id: USER.id, resume_id: RESUME_ID, report_id: null });
    expect(chargeFor(critique.id)).toMatchObject({ user_id: USER.id, kind: "resume_report", refunded_at: null });
    expect(db.activeCharges(USER.id)).toBe(1);

    // Every stored original_text is an exact substring of resumes.extracted_text.
    for (const item of row.line_feedback as Array<{ original_text: string }>) {
      expect(UNICODE_RESUME.includes(item.original_text)).toBe(true);
    }

    expect(mockRunCritique).toHaveBeenCalledWith(
      { resumeText: UNICODE_RESUME, sourceText: UNICODE_RESUME },
      { userId: USER.id, signal },
    );
  });

  it("a second request returns the stored critique (200, same id) with no charge and no Claude call", async () => {
    const first = await run();
    const chargesBefore = db.tables.rate_limit_events.length;
    const rpcBefore = db.count("session:rpc:request_resume_critique");
    mockRunCritique.mockClear();

    const second = await run();
    expect(second).toMatchObject({ kind: "ok", status: 200 });
    if (first.kind !== "ok" || second.kind !== "ok") return;
    expect(second.critique.id).toBe(first.critique.id);
    expect(mockRunCritique).not.toHaveBeenCalled();
    expect(db.count("session:rpc:request_resume_critique")).toBe(rpcBefore);
    expect(db.tables.rate_limit_events).toHaveLength(chargesBefore);
    expect(db.count("admin:rpc:ai_spend_summary")).toBe(1); // only the first request checked the budget
  });

  it("a critique from an older prompt version is not a cache hit", async () => {
    db.tables.resume_critiques.push({
      id: "old-critique",
      user_id: USER.id,
      resume_id: RESUME_ID,
      report_id: null,
      prompt_version: "critique-v0",
      created_at: "2026-11-01T00:00:00.000Z",
    });
    const result = await run();
    expect(result).toMatchObject({ kind: "ok", status: 201 });
    expect(mockRunCritique).toHaveBeenCalledTimes(1);
  });
});

describe("requestCritique: ownership", () => {
  it("another user's resume is not_found, with no charge and no Claude call", async () => {
    const result = await run(OTHER);
    expect(result).toEqual({ kind: "not_found" });
    expect(db.count("session:rpc:request_resume_critique")).toBe(0);
    expect(db.tables.rate_limit_events).toHaveLength(0);
    expect(mockRunCritique).not.toHaveBeenCalled();
  });

  it("an unknown resume id is not_found", async () => {
    expect(await run(USER, "22222222-2222-4222-8222-222222222222")).toEqual({ kind: "not_found" });
  });

  it("maps the RPC's not_found (resume deleted between load and charge)", async () => {
    db.failNext("session:rpc:request_resume_critique", { code: "P0001", message: "not_found" });
    expect(await run()).toEqual({ kind: "not_found" });
    expect(mockRunCritique).not.toHaveBeenCalled();
  });
});

describe("requestCritique: text extraction happens before the charge", () => {
  beforeEach(() => {
    db.tables.resumes[0].extracted_text = null;
  });

  it("extracts, persists extracted_text (status untouched), then charges and runs", async () => {
    mockDownload.mockResolvedValue(Buffer.from("pdf"));
    mockExtract.mockResolvedValue(UNICODE_RESUME);
    const result = await run();
    expect(result).toMatchObject({ kind: "ok", status: 201 });
    expect(mockDownload).toHaveBeenCalledWith(expect.anything(), `${USER.id}/${RESUME_ID}.pdf`);
    expect(mockExtract).toHaveBeenCalledWith("application/pdf", Buffer.from("pdf"));
    expect(db.tables.resumes[0]).toMatchObject({ extracted_text: UNICODE_RESUME, status: "uploaded" });
    const update = db.calls.find((c) => c.key === "session:resumes:update");
    expect(update?.args).toEqual({ extracted_text: UNICODE_RESUME });
  });

  it.each([
    ["an extraction error", () => mockExtract.mockRejectedValue(new ResumeTextExtractionError("bad pdf"))],
    ["a storage error", () => mockDownload.mockRejectedValue(new ResumeStorageError("missing"))],
    ["empty text", () => mockExtract.mockResolvedValue("   \n ")],
  ])("%s -> text_extraction_failed, no budget check, no charge", async (_label, arrange) => {
    mockDownload.mockResolvedValue(Buffer.from("pdf"));
    arrange();
    expect(await run()).toEqual({ kind: "text_extraction_failed" });
    expect(db.count("admin:rpc:ai_spend_summary")).toBe(0);
    expect(db.count("session:rpc:request_resume_critique")).toBe(0);
    expect(db.tables.resumes[0].status).toBe("uploaded");
  });

  it("stored whitespace-only text -> text_extraction_failed, no charge", async () => {
    db.tables.resumes[0].extracted_text = "  \n\t ";
    expect(await run()).toEqual({ kind: "text_extraction_failed" });
    expect(db.count("session:rpc:request_resume_critique")).toBe(0);
  });

  it("failing to persist the extracted text is an internal_error before any charge", async () => {
    mockDownload.mockResolvedValue(Buffer.from("pdf"));
    mockExtract.mockResolvedValue(UNICODE_RESUME);
    db.failNext("session:resumes:update", { code: "57014", message: "timeout" });
    expect(await run()).toEqual({ kind: "internal_error", refunded: false });
    expect(db.count("session:rpc:request_resume_critique")).toBe(0);
  });
});

describe("requestCritique: global budget (§13.9.4)", () => {
  it("exhausted -> budget_exhausted with the next UTC midnight, no charge, no Claude call", async () => {
    db.setSpendUsd(15);
    const result = await run();
    expect(result.kind).toBe("budget_exhausted");
    if (result.kind !== "budget_exhausted") return;
    const now = new Date();
    expect(result.retryAfter).toBe(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(),
    );
    expect(db.count("session:rpc:request_resume_critique")).toBe(0);
    expect(mockRunCritique).not.toHaveBeenCalled();
  });

  it("GLOBAL_DAILY_AI_BUDGET_USD=0 pauses critiques", async () => {
    process.env.GLOBAL_DAILY_AI_BUDGET_USD = "0";
    expect((await run()).kind).toBe("budget_exhausted");
  });

  it("just under the budget proceeds", async () => {
    db.setSpendUsd(14.99);
    expect(await run()).toMatchObject({ kind: "ok", status: 201 });
  });

  it("a spend query error fails closed (internal_error, no charge)", async () => {
    db.failNext("admin:rpc:ai_spend_summary", { code: "57014", message: "timeout" });
    expect(await run()).toEqual({ kind: "internal_error", refunded: false });
    expect(db.count("session:rpc:request_resume_critique")).toBe(0);
  });
});

describe("requestCritique: charge (request_resume_critique)", () => {
  it("at the daily limit -> rate_limited, no Claude call", async () => {
    for (let i = 0; i < 5; i += 1) {
      db.tables.rate_limit_events.push({ id: `e${i}`, user_id: USER.id, kind: "resume_report", ref_id: null, refunded_at: null });
    }
    const result = await run();
    expect(result.kind).toBe("rate_limited");
    expect(mockRunCritique).not.toHaveBeenCalled();
  });

  it("refunded charges don't count toward the limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      db.tables.rate_limit_events.push({ id: `e${i}`, user_id: USER.id, kind: "resume_report", ref_id: null, refunded_at: i === 0 ? "t" : null });
    }
    expect(await run()).toMatchObject({ kind: "ok", status: 201 });
  });

  it("another RPC error -> internal_error without a refund (nothing was charged)", async () => {
    db.failNext("session:rpc:request_resume_critique", { code: "P0001", message: "rate_limit_kind_unknown:resume_report" });
    expect(await run()).toEqual({ kind: "internal_error", refunded: false });
    expect(mockRunCritique).not.toHaveBeenCalled();
  });
});

describe("requestCritique: failures after the charge (refund only for system failures)", () => {
  const latestCharge = () => db.tables.rate_limit_events[db.tables.rate_limit_events.length - 1];

  it.each([
    ["ai_unavailable (incl. the deadline)", () => new ClaudeApiError("aborted", { code: "ai_unavailable", retryable: true }), true],
    ["ai_bad_request", () => new ClaudeBadRequestError("400"), true],
    ["ai_refused", () => new ClaudeRefusalError("refused", { category: null, requestId: null }), false],
    ["ai_invalid_output", () => new ClaudeInvalidOutputError("invalid"), false],
    ["ai_truncated", () => new ClaudeTruncatedError("truncated", { requestId: null }), false],
  ])("%s -> ai_error, refunded=%s", async (_label, makeError, refunded) => {
    const error = makeError();
    mockRunCritique.mockRejectedValue(error);
    const result = await run();
    expect(result).toEqual({ kind: "ai_error", code: error.code, refunded });
    expect(latestCharge().refunded_at == null).toBe(!refunded);
    expect(db.activeCharges(USER.id)).toBe(refunded ? 0 : 1);
    expect(db.tables.resume_critiques).toHaveLength(0);
  });

  it("an unexpected (non-Claude) error -> internal_error, refunded", async () => {
    mockRunCritique.mockRejectedValue(new TypeError("bug"));
    expect(await run()).toEqual({ kind: "internal_error", refunded: true });
    expect(db.activeCharges(USER.id)).toBe(0);
  });

  it("an insert failure -> internal_error, refunded", async () => {
    db.failNext("admin:resume_critiques:insert", { code: "57014", message: "timeout" });
    expect(await run()).toEqual({ kind: "internal_error", refunded: true });
    expect(db.activeCharges(USER.id)).toBe(0);
  });

  it("the resume deleted during the Claude call -> the owner trigger rejects the insert; refunded", async () => {
    mockRunCritique.mockImplementation(async () => {
      db.tables.resumes.length = 0;
      return outcome();
    });
    expect(await run()).toEqual({ kind: "internal_error", refunded: true });
    expect(logs.join("\n")).toContain("validation_owner_mismatch");
  });

  it("a concurrent winner on the cache key -> the winner is returned (200) and this charge STANDS (no refund)", async () => {
    mockRunCritique.mockImplementation(async () => {
      db.tables.resume_critiques.push({
        id: "winner-critique",
        user_id: USER.id,
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
    const result = await run();
    expect(result).toMatchObject({ kind: "ok", status: 200, critique: { id: "winner-critique" } });
    expect(db.tables.resume_critiques).toHaveLength(1);
    expect(db.activeCharges(USER.id)).toBe(1);
    expect(latestCharge().refunded_at).toBeNull();
    expect(db.count("admin:rate_limit_events:update")).toBe(0);
  });

  it("a failed refund is logged with ids only and never thrown", async () => {
    mockRunCritique.mockRejectedValue(new ClaudeApiError("down", { code: "ai_unavailable", retryable: true }));
    db.failNext("admin:rate_limit_events:update", { code: "57014", message: "timeout" });
    expect(await run()).toEqual({ kind: "ai_error", code: "ai_unavailable", refunded: false });
    const refundLog = logs.find((l) => l.includes('"stage":"refund"'));
    expect(refundLog).toBeDefined();
    expect(refundLog).toContain('"critique_id"');
  });
});

describe("requestCritique: privacy", () => {
  it("never logs resume or critique text, on success or failure paths", async () => {
    await run();
    mockRunCritique.mockRejectedValue(new ClaudeInvalidOutputError("x"));
    db.tables.resume_critiques.length = 0;
    await run();
    db.tables.resume_critiques.length = 0;
    mockRunCritique.mockRejectedValue(new TypeError(UNICODE_RESUME));
    await run();
    const all = logs.join("\n");
    for (const fragment of ["Alex", "HVAC", "turbine", "alex.example", "promising"]) {
      expect(all).not.toContain(fragment);
    }
  });

  it("createAdminClient is imported only by the §13.14-listed critique files", () => {
    const critiqueFiles = repoSourceFiles().filter(
      (f) =>
        !isTestFile(f) &&
        (f.startsWith("lib/critique/") ||
          f === "lib/supabase/queries/critiques.ts" ||
          f.startsWith("app/api/resumes/[id]/critique/") ||
          f === "lib/claude/tasks/critiqueResume.ts"),
    );
    expect(critiqueFiles).toEqual(
      expect.arrayContaining([
        "app/api/resumes/[id]/critique/route.ts",
        "lib/critique/service.ts",
        "lib/supabase/queries/critiques.ts",
      ]),
    );
    const importers = critiqueFiles.filter((file) =>
      importsOf(readFileSync(join(REPO_ROOT, file), "utf8")).some(
        (site) => site.specifier === "@/lib/supabase/admin" && !site.typeOnly,
      ),
    );
    expect(importers).toEqual(["lib/critique/service.ts"]);
  });
});
