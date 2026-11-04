import { describe, expect, it } from "vitest";

import {
  classifyTaskError,
  computeBackoffSeconds,
  DEFAULT_RETRYABLE,
  isTaskErrorCode,
  MAX_ERROR_MESSAGE_LENGTH,
  safeErrorName,
  sanitizeErrorMessage,
  TASK_ERROR_CODES,
  TaskError,
} from "@/lib/tasks/errors";

const ctx = { previousErrorCode: null, timedOut: false };

function namedError(name: string, extra: Record<string, unknown> = {}) {
  const err = new Error("SECRET resume text: Jane Doe, 555-0100");
  err.name = name;
  return Object.assign(err, extra);
}

describe("TaskError", () => {
  it("defaults retryable from the §13.4.5 table", () => {
    expect(new TaskError("ai_unavailable").retryable).toBe(true);
    expect(new TaskError("ai_refused").retryable).toBe(false);
    expect(new TaskError("ownership_mismatch").retryable).toBe(false);
    expect(new TaskError("fetch_failed").retryable).toBe(true);
    expect(new TaskError("fetch_blocked").retryable).toBe(false);
  });

  it("allows overriding retryable and keeps code/name", () => {
    const err = new TaskError("internal_error", "boom", { retryable: false });
    expect(err.retryable).toBe(false);
    expect(err.code).toBe("internal_error");
    expect(err.name).toBe("TaskError");
    expect(err.message).toBe("boom");
  });

  it("has a retryability entry for every code", () => {
    for (const code of TASK_ERROR_CODES) {
      expect(typeof DEFAULT_RETRYABLE[code]).toBe("boolean");
      expect(isTaskErrorCode(code)).toBe(true);
    }
    expect(isTaskErrorCode("nope")).toBe(false);
  });
});

describe("sanitizeErrorMessage", () => {
  it("strips control characters and collapses whitespace", () => {
    expect(sanitizeErrorMessage("a\n\tb\u0000c   d")).toBe("a b c d");
  });

  it("truncates to 500 characters", () => {
    const out = sanitizeErrorMessage("x".repeat(2000));
    expect(out).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
  });

  it("returns null for empty / non-string input", () => {
    expect(sanitizeErrorMessage("  \n ")).toBeNull();
    expect(sanitizeErrorMessage(undefined)).toBeNull();
    expect(sanitizeErrorMessage(42)).toBeNull();
  });
});

describe("safeErrorName", () => {
  it("accepts identifier-shaped names only", () => {
    expect(safeErrorName(namedError("TypeError"))).toBe("TypeError");
    expect(safeErrorName(namedError("bad name with spaces"))).toBe("Error");
    expect(safeErrorName("a string")).toBe("Error");
    expect(safeErrorName(null)).toBe("Error");
  });
});

describe("classifyTaskError", () => {
  it("passes TaskError code/retryable/message through (sanitized)", () => {
    const out = classifyTaskError(new TaskError("not_a_resume", "Not a resume\n(report r1)"), ctx);
    expect(out).toEqual({ code: "not_a_resume", retryable: false, message: "Not a resume (report r1)" });
  });

  it("never persists the message of a non-TaskError (PII rule)", () => {
    const out = classifyTaskError(namedError("TypeError"), ctx);
    expect(out.code).toBe("internal_error");
    expect(out.retryable).toBe(true);
    expect(out.message).toBe("Unhandled TypeError");
    expect(out.message).not.toContain("Jane");
  });

  it("handles thrown non-Error values", () => {
    expect(classifyTaskError("raw string with PII", ctx)).toEqual({
      code: "internal_error",
      retryable: true,
      message: "Unhandled Error",
    });
  });

  it.each([
    ["ClaudeRefusalError", "ai_refused", false],
    ["ClaudeTruncatedError", "ai_truncated", false],
    ["ClaudeInvalidOutputError", "ai_invalid_output", true],
    ["ClaudeBadRequestError", "ai_bad_request", false],
  ] as const)("maps %s → %s", (name, code, retryable) => {
    const out = classifyTaskError(namedError(name), ctx);
    expect(out.code).toBe(code);
    expect(out.retryable).toBe(retryable);
    expect(out.message).toBe(`Unhandled ${name}`);
  });

  it("maps a retryable ClaudeApiError to ai_unavailable", () => {
    const out = classifyTaskError(namedError("ClaudeApiError", { retryable: true }), ctx);
    expect(out).toMatchObject({ code: "ai_unavailable", retryable: true });
  });

  it("maps a non-retryable ClaudeApiError to ai_bad_request", () => {
    const out = classifyTaskError(namedError("ClaudeApiError", { retryable: false }), ctx);
    expect(out).toMatchObject({ code: "ai_bad_request", retryable: false });
  });

  it("ai_invalid_output is retryable once more, then final", () => {
    const first = classifyTaskError(namedError("ClaudeInvalidOutputError"), {
      previousErrorCode: "ai_unavailable",
      timedOut: false,
    });
    expect(first.retryable).toBe(true);

    const second = classifyTaskError(new TaskError("ai_invalid_output"), {
      previousErrorCode: "ai_invalid_output",
      timedOut: false,
    });
    expect(second.retryable).toBe(false);
  });

  it("labels deadline aborts as a retryable time-budget internal_error", () => {
    const out = classifyTaskError(namedError("TaskDeadlineError"), { previousErrorCode: null, timedOut: true });
    expect(out).toEqual({
      code: "internal_error",
      retryable: true,
      message: "Task exceeded its time budget (maxDurationMs).",
    });
  });
});

describe("computeBackoffSeconds", () => {
  const mid = () => 0.5; // jitter factor exactly 1.0

  it("follows min(30 × 4^(n−1), 3600)", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => computeBackoffSeconds(n, mid))).toEqual([
      30, 120, 480, 1920, 3600, 3600,
    ]);
  });

  it("applies ±20% jitter", () => {
    expect(computeBackoffSeconds(1, () => 0)).toBe(24);
    expect(computeBackoffSeconds(1, () => 1)).toBe(36);
    expect(computeBackoffSeconds(5, () => 1)).toBe(4320);
  });

  it("treats attempts < 1 as the first attempt and survives a bad RNG", () => {
    expect(computeBackoffSeconds(0, mid)).toBe(30);
    expect(computeBackoffSeconds(1, () => Number.NaN)).toBe(30);
  });
});
