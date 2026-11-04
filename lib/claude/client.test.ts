import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  __resetClaudeClientForTests,
  __setClaudeClientForTests,
  buildStructuredParams,
  callStructured,
  classifySdkError,
  retryOnceOnInvalidOutput,
  SERVER_SIDE_FALLBACK_BETA,
} from "@/lib/claude/client";
import { CLAUDE_TASKS } from "@/lib/claude/config";
import {
  ClaudeApiError,
  ClaudeBadRequestError,
  ClaudeInvalidOutputError,
  ClaudeRefusalError,
  ClaudeTruncatedError,
} from "@/lib/claude/errors";
import { setUsageSink, type UsageEvent } from "@/lib/claude/usage";

/**
 * Unit coverage for `callStructured` (docs/ARCHITECTURE.md §13.5.2): request
 * shape, usage-before-inspection, stop_reason / parsed-output / SDK error
 * classification, and the no-content-in-logs rule. Uses a fake client. No
 * network.
 */

const Schema = z.object({ score: z.number().int(), note: z.string() });

const SECRET_RESUME = "SECRET-RESUME-CONTENT Jane Doe 555-0100";
const SECRET_OUTPUT = "SECRET-MODEL-OUTPUT";

function baseArgs() {
  return {
    task: "matchResumeToJob" as const,
    system: [
      { type: "text" as const, text: "rules" },
      { type: "text" as const, text: "vocab", cache_control: { type: "ephemeral" as const } },
      { type: "text" as const, text: "rubric" },
    ],
    userContent: `<resume_text>\n${SECRET_RESUME}\n</resume_text>`,
    schema: Schema,
    usageContext: { userId: "user-1", taskId: "task-1", taskAttempt: 2 },
  };
}

type FakeMessage = {
  model: string;
  stop_reason: string | null;
  stop_details?: { category: string | null } | null;
  content: Array<Record<string, unknown>>;
  usage: Record<string, unknown>;
};

function message(overrides: Partial<FakeMessage> = {}): FakeMessage {
  return {
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "text", text: JSON.stringify({ score: 70, note: "fine" }) }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  };
}

let create: ReturnType<typeof vi.fn>;
let usageEvents: UsageEvent[];
let logLines: string[];

function respondWith(msg: FakeMessage, requestId: string | null = "req_test") {
  create.mockReturnValueOnce({
    withResponse: async () => ({ data: msg, request_id: requestId }),
  });
}

function rejectWith(err: unknown) {
  create.mockReturnValueOnce({
    withResponse: async () => {
      throw err;
    },
  });
}

function apiError(status: number, type = "api_error") {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message: `upstream said ${SECRET_RESUME}` } },
    undefined,
    new Headers({ "request-id": "req_err" }),
  );
}

beforeEach(() => {
  create = vi.fn();
  __setClaudeClientForTests({ beta: { messages: { create } } } as unknown as Anthropic);
  usageEvents = [];
  setUsageSink((e) => {
    usageEvents.push(e);
  });
  logLines = [];
  const capture = (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "info").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "log").mockImplementation(capture);
});

afterEach(() => {
  __resetClaudeClientForTests();
  setUsageSink(null);
  vi.restoreAllMocks();
});

function expectNoContentLogged() {
  const all = logLines.join("\n");
  expect(all).not.toContain("SECRET-RESUME");
  expect(all).not.toContain(SECRET_OUTPUT);
}

// ---------------------------------------------------------------------------

describe("buildStructuredParams", () => {
  it("uses the task config: model, max_tokens, effort", () => {
    const params = buildStructuredParams(baseArgs());
    const cfg = CLAUDE_TASKS.matchResumeToJob;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.max_tokens).toBe(cfg.maxTokens);
    expect(params.output_config?.effort).toBe("medium");
  });

  it("sends the zod schema as a json_schema output format (no parse function on the wire)", () => {
    const params = buildStructuredParams(baseArgs());
    const format = params.output_config?.format as { type: string; schema: Record<string, unknown> };
    expect(format.type).toBe("json_schema");
    expect(format.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["score", "note"],
    });
    expect(Object.keys(format)).toEqual(["type", "schema"]);
  });

  it("enables the server-side refusal fallback", () => {
    const params = buildStructuredParams(baseArgs());
    expect(params.betas).toEqual([SERVER_SIDE_FALLBACK_BETA]);
    expect(params.fallbacks).toBe("default");
  });

  it("puts cache_control on the last system block only", () => {
    const params = buildStructuredParams(baseArgs());
    const system = params.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system.map((b) => b.text)).toEqual(["rules", "vocab", "rubric"]);
    expect(system[0].cache_control).toBeUndefined();
    expect(system[1].cache_control).toBeUndefined();
    expect(system[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("sends a single user message with the given content, and no prefill", () => {
    const params = buildStructuredParams(baseArgs());
    expect(params.messages).toEqual([{ role: "user", content: baseArgs().userContent }]);
  });

  it("never sends tools, tool choice, sampling params, or thinking overrides", () => {
    const params = buildStructuredParams(baseArgs()) as unknown as Record<string, unknown>;
    for (const key of ["tools", "tool_choice", "temperature", "top_p", "top_k", "thinking", "stop_sequences"]) {
      expect(params, key).not.toHaveProperty(key);
    }
  });

  it("every configured task stays within the non-streaming guard (<= 20k tokens)", () => {
    for (const [name, cfg] of Object.entries(CLAUDE_TASKS)) {
      expect(cfg.maxTokens, name).toBeLessThanOrEqual(20_000);
      expect(cfg.model, name).toBe("claude-opus-5-5");
    }
  });

  it("rejects an empty system array", () => {
    expect(() => buildStructuredParams({ ...baseArgs(), system: [] })).toThrow();
  });
});

describe("lib/claude source hygiene (M1.1 acceptance)", () => {
  it("no non-test file in lib/claude mentions forbidden request params", () => {
    const root = join(process.cwd(), "lib", "claude");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(5);
    const forbidden = /tool_choice|temperature|top_p|top_k/;
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(forbidden);
    }
  });
});

describe("callStructured — success", () => {
  it("returns the schema-validated value, served model, stop reason, usage and request id", async () => {
    respondWith(message());
    const result = await callStructured(baseArgs());
    expect(result).toEqual({
      value: { score: 70, note: "fine" },
      model: "claude-opus-5-5",
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0014,
        priceKnown: true,
      },
      requestId: "req_test",
    });
  });

  it("passes the abort signal and the task timeout to the SDK", async () => {
    respondWith(message());
    const controller = new AbortController();
    await callStructured({ ...baseArgs(), signal: controller.signal });
    expect(create).toHaveBeenCalledWith(expect.any(Object), {
      signal: controller.signal,
      timeout: CLAUDE_TASKS.matchResumeToJob.timeoutMs,
    });
  });

  it("records one usage event with the full context, priced by the served model", async () => {
    respondWith(message({ model: "claude-sonnet-5-5" }));
    await callStructured(baseArgs());
    expect(usageEvents).toEqual([
      {
        provider: "anthropic",
        operation: "matchResumeToJob",
        model: "claude-sonnet-5-5",
        isBatch: false,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0007,
        stopReason: "end_turn",
        requestId: "req_test",
        userId: "user-1",
        taskId: "task-1",
        taskAttempt: 2,
      },
    ]);
  });

  it("reads only the answer after a fallback boundary block", async () => {
    respondWith(
      message({
        model: "claude-sonnet-5-5",
        content: [
          { type: "text", text: '{"score": 1, "no' },
          { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-sonnet-5-5" } },
          { type: "text", text: JSON.stringify({ score: 55, note: "served by fallback" }) },
        ],
      }),
    );
    const result = await callStructured(baseArgs());
    expect(result.value).toEqual({ score: 55, note: "served by fallback" });
    expect(result.model).toBe("claude-sonnet-5-5");
  });

  it("ignores thinking blocks", async () => {
    respondWith(
      message({
        content: [
          { type: "thinking", thinking: "...", signature: "sig" },
          { type: "text", text: JSON.stringify({ score: 5, note: "n" }) },
        ],
      }),
    );
    await expect(callStructured(baseArgs())).resolves.toMatchObject({ value: { score: 5 } });
  });

  it("logs only metadata", async () => {
    respondWith(message());
    await callStructured(baseArgs());
    expect(logLines).toHaveLength(1);
    const entry = JSON.parse(logLines[0].replace(/^\[claude\] /, ""));
    expect(Object.keys(entry).sort()).toEqual(
      [
        "cache_read_tokens",
        "cache_write_tokens",
        "input_tokens",
        "model",
        "output_tokens",
        "request_id",
        "stop_reason",
        "task",
      ].sort(),
    );
  });
});

describe("callStructured — stop_reason classification (usage is recorded first)", () => {
  it("refusal -> ClaudeRefusalError (not retryable) with the policy category", async () => {
    respondWith(
      message({
        stop_reason: "refusal",
        stop_details: { category: "cyber" },
        content: [{ type: "text", text: SECRET_OUTPUT }],
      }),
    );
    const err = await callStructured(baseArgs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeRefusalError);
    expect(err).toBeInstanceOf(ClaudeApiError);
    expect(err).toMatchObject({ code: "ai_refused", retryable: false, category: "cyber", requestId: "req_test" });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].stopReason).toBe("refusal");
    expect((err as Error).message).not.toContain(SECRET_OUTPUT);
    expectNoContentLogged();
  });

  it("refusal with no stop_details still classifies", async () => {
    respondWith(message({ stop_reason: "refusal", stop_details: null, content: [] }));
    await expect(callStructured(baseArgs())).rejects.toMatchObject({ code: "ai_refused", category: null });
  });

  it("max_tokens -> ClaudeTruncatedError (not retryable), even if the text happens to parse", async () => {
    respondWith(message({ stop_reason: "max_tokens" }));
    const err = await callStructured(baseArgs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeTruncatedError);
    expect(err).toMatchObject({ code: "ai_truncated", retryable: false });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].stopReason).toBe("max_tokens");
  });

  it("model_context_window_exceeded -> ClaudeTruncatedError", async () => {
    respondWith(message({ stop_reason: "model_context_window_exceeded" }));
    await expect(callStructured(baseArgs())).rejects.toBeInstanceOf(ClaudeTruncatedError);
  });

  it.each(["tool_use", "pause_turn", "stop_sequence", null])(
    "stop_reason %s -> ClaudeInvalidOutputError (retryable)",
    async (stop) => {
      respondWith(message({ stop_reason: stop }));
      const err = await callStructured(baseArgs()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ClaudeInvalidOutputError);
      expect(err).toMatchObject({ code: "ai_invalid_output", retryable: true });
      expect(usageEvents).toHaveLength(1);
    },
  );
});

describe("callStructured — parsed output", () => {
  it("no text block (null parsed output) -> ClaudeInvalidOutputError, usage recorded", async () => {
    respondWith(message({ content: [] }));
    const err = await callStructured(baseArgs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeInvalidOutputError);
    expect((err as Error).message).toContain("no text block");
    expect(usageEvents).toHaveLength(1);
  });

  it("non-JSON text -> ClaudeInvalidOutputError without quoting the output", async () => {
    respondWith(message({ content: [{ type: "text", text: `{"score": 1, "note": "${SECRET_OUTPUT}` }] }));
    const err = await callStructured(baseArgs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeInvalidOutputError);
    expect((err as Error).message).toContain("not valid JSON");
    expect((err as Error).message).not.toContain(SECRET_OUTPUT);
    expect((err as Error).cause).toBeUndefined();
    expectNoContentLogged();
  });

  it("schema mismatch -> ClaudeInvalidOutputError naming paths, not values", async () => {
    respondWith(
      message({ content: [{ type: "text", text: JSON.stringify({ score: 1.5, note: 42, extra: SECRET_OUTPUT }) }] }),
    );
    const err = await callStructured(baseArgs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeInvalidOutputError);
    expect((err as Error).message).toMatch(/schema mismatch at score, note/);
    expect((err as Error).message).not.toContain(SECRET_OUTPUT);
    expectNoContentLogged();
  });

  it("the request content is never logged on any path", async () => {
    respondWith(message({ content: [] }));
    await callStructured(baseArgs()).catch(() => undefined);
    rejectWith(apiError(400, "invalid_request_error"));
    await callStructured(baseArgs()).catch(() => undefined);
    expectNoContentLogged();
  });
});

describe("callStructured — SDK error classification (no usage recorded: nothing billed)", () => {
  it("400 -> ClaudeBadRequestError (not retryable), message without upstream text", async () => {
    rejectWith(apiError(400, "invalid_request_error"));
    const err = await callStructured(baseArgs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeBadRequestError);
    expect(err).toMatchObject({ code: "ai_bad_request", retryable: false, status: 400, requestId: "req_err" });
    expect((err as Error).message).not.toContain("SECRET");
    expect(usageEvents).toHaveLength(0);
    expectNoContentLogged();
  });

  it.each([
    [429, "rate_limit_error"],
    [500, "api_error"],
    [503, "api_error"],
    [529, "overloaded_error"],
  ])("%i -> ClaudeApiError ai_unavailable (retryable)", async (status, type) => {
    rejectWith(apiError(status, type));
    const err = await callStructured(baseArgs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeApiError);
    expect(err).not.toBeInstanceOf(ClaudeBadRequestError);
    expect(err).toMatchObject({ code: "ai_unavailable", retryable: true, status });
    expect(usageEvents).toHaveLength(0);
  });

  it("400 and 429 are classified differently", async () => {
    rejectWith(apiError(400));
    rejectWith(apiError(429));
    const a = await callStructured(baseArgs()).catch((e: unknown) => e);
    const b = await callStructured(baseArgs()).catch((e: unknown) => e);
    expect((a as ClaudeApiError).retryable).toBe(false);
    expect((b as ClaudeApiError).retryable).toBe(true);
  });

  it.each([
    ["connection error", new Anthropic.APIConnectionError({ message: "socket hang up" })],
    ["timeout", new Anthropic.APIConnectionTimeoutError()],
    ["abort", new Anthropic.APIUserAbortError()],
  ])("%s -> retryable ai_unavailable", async (_name, sdkErr) => {
    rejectWith(sdkErr);
    await expect(callStructured(baseArgs())).rejects.toMatchObject({
      code: "ai_unavailable",
      retryable: true,
    });
  });

  it.each([401, 403])("%i -> non-retryable ai_unavailable (operator must fix the key)", async (status) => {
    rejectWith(apiError(status));
    await expect(callStructured(baseArgs())).rejects.toMatchObject({
      code: "ai_unavailable",
      retryable: false,
    });
  });

  it.each([404, 413, 422])("%i -> ClaudeBadRequestError", async (status) => {
    rejectWith(apiError(status));
    await expect(callStructured(baseArgs())).rejects.toBeInstanceOf(ClaudeBadRequestError);
  });

  it("409 -> retryable", async () => {
    rejectWith(apiError(409));
    await expect(callStructured(baseArgs())).rejects.toMatchObject({ retryable: true });
  });

  it("an SDK-side refusal to send (e.g. the non-streaming guard) -> ClaudeBadRequestError", async () => {
    rejectWith(new Anthropic.AnthropicError("Streaming is required for operations that may take longer than 10 minutes."));
    await expect(callStructured(baseArgs())).rejects.toBeInstanceOf(ClaudeBadRequestError);
  });

  it("an unknown thrown value -> retryable ai_unavailable", async () => {
    rejectWith(new TypeError("weird"));
    await expect(callStructured(baseArgs())).rejects.toMatchObject({
      code: "ai_unavailable",
      retryable: true,
    });
  });

  it("missing API key -> non-retryable ClaudeApiError", async () => {
    __resetClaudeClientForTests();
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(callStructured(baseArgs())).rejects.toMatchObject({
        name: "ClaudeApiError",
        code: "ai_unavailable",
        retryable: false,
      });
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("classifySdkError passes Claude errors through unchanged", () => {
    const original = new ClaudeTruncatedError("x");
    expect(classifySdkError(original, "analyzeResume")).toBe(original);
  });
});

describe("retryOnceOnInvalidOutput", () => {
  it("retries exactly once on ClaudeInvalidOutputError", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ClaudeInvalidOutputError("bad"))
      .mockResolvedValueOnce("ok");
    await expect(retryOnceOnInvalidOutput(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second invalid output", async () => {
    const fn = vi.fn().mockRejectedValue(new ClaudeInvalidOutputError("bad"));
    await expect(retryOnceOnInvalidOutput(fn)).rejects.toBeInstanceOf(ClaudeInvalidOutputError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([
    new ClaudeRefusalError("r", { category: null }),
    new ClaudeTruncatedError("t"),
    new ClaudeBadRequestError("b"),
    new ClaudeApiError("u", { code: "ai_unavailable", retryable: true }),
  ])("does not retry %s", async (err) => {
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryOnceOnInvalidOutput(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
