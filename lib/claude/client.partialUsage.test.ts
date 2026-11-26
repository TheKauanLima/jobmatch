import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  __resetClaudeClientForTests,
  __setClaudeClientForTests,
  callStructured,
  PARTIAL_USAGE_STOP_REASON,
} from "@/lib/claude/client";
import { CLAUDE_TASKS } from "@/lib/claude/config";
import { ClaudeApiError, ClaudeBadRequestError } from "@/lib/claude/errors";
import { costFromUsage, recordUsage } from "@/lib/claude/usage";

/**
 * §13.5.2 step 3 for streams that fail AFTER they started: callStructured
 * records the SDK's partial snapshot (`stream.currentMessage`) usage, marked
 * with `PARTIAL_USAGE_STOP_REASON`, before throwing the classified error.
 * `recordUsage` is mocked so a throwing implementation can be simulated
 * (the real one never throws). The real-SDK path is covered in
 * client.test.ts ("real SDK stream" block).
 */

vi.mock("@/lib/claude/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/claude/usage")>();
  return { ...actual, recordUsage: vi.fn(async () => {}) };
});

const recordUsageMock = vi.mocked(recordUsage);

const SECRET_OUTPUT = "SECRET-PARTIAL-OUTPUT";

function args() {
  return {
    task: "critiqueResume" as const,
    system: [{ type: "text" as const, text: "rules" }],
    userContent: "<resume_text>\nSECRET-RESUME\n</resume_text>",
    schema: z.object({ ok: z.boolean() }),
    usageContext: { userId: "user-9", taskId: null, taskAttempt: null },
  };
}

const partialUsage = {
  input_tokens: 4_000,
  output_tokens: 1,
  cache_read_input_tokens: 2_000,
  cache_creation_input_tokens: 500,
};

/** A fake BetaMessageStream whose finalMessage rejects with `err`, with or without a partial snapshot. */
function failingStream(
  err: unknown,
  opts: { partial?: Record<string, unknown>; requestId?: string } = {},
) {
  return {
    request_id: opts.requestId,
    currentMessage: opts.partial,
    finalMessage: async () => {
      throw err;
    },
    abort: vi.fn(),
  };
}

function partialMessage(model = "claude-opus-5-5") {
  return {
    id: "msg_partial",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: `{"ok": tr ${SECRET_OUTPUT}` }],
    stop_reason: null,
    stop_details: null,
    usage: { ...partialUsage },
  };
}

let streamCall: ReturnType<typeof vi.fn>;
let logLines: string[];

beforeEach(() => {
  streamCall = vi.fn();
  __setClaudeClientForTests({ beta: { messages: { stream: streamCall } } } as unknown as Anthropic);
  recordUsageMock.mockReset();
  recordUsageMock.mockImplementation(async () => {});
  logLines = [];
  const capture = (...a: unknown[]) => {
    logLines.push(a.map(String).join(" "));
  };
  vi.spyOn(console, "info").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  __resetClaudeClientForTests();
  vi.restoreAllMocks();
});

const midStreamDrop = () =>
  Object.assign(new Anthropic.AnthropicError("terminated"), { cause: new TypeError("terminated") });

describe("callStructured — partial usage on a mid-stream failure", () => {
  it("records the partial snapshot's usage once, marked stream_failed, then throws the classified error", async () => {
    streamCall.mockReturnValueOnce(
      failingStream(midStreamDrop(), { partial: partialMessage(), requestId: "req_partial" }),
    );

    const err = await callStructured(args()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClaudeApiError);
    expect(err).toMatchObject({ code: "ai_unavailable", retryable: true, requestId: "req_partial" });
    expect(recordUsageMock).toHaveBeenCalledTimes(1);
    expect(recordUsageMock).toHaveBeenCalledWith({
      provider: "anthropic",
      operation: "critiqueResume",
      model: "claude-opus-5-5",
      isBatch: false,
      inputTokens: 4_000,
      outputTokens: 1,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 500,
      costUsd: costFromUsage("claude-opus-5-5", partialUsage).costUsd,
      stopReason: PARTIAL_USAGE_STOP_REASON,
      requestId: "req_partial",
      userId: "user-9",
      taskId: null,
      taskAttempt: null,
    });
    expect(PARTIAL_USAGE_STOP_REASON).toBe("stream_failed");
    // Fits ai_usage_events.stop_reason (text, <= 100 chars, migration 0007).
    expect(PARTIAL_USAGE_STOP_REASON.length).toBeLessThanOrEqual(100);
    expect(logLines.join("\n")).not.toContain(SECRET_OUTPUT);
  });

  it("prices by the partial message's model (e.g. a fallback model the SDK relabeled to)", async () => {
    streamCall.mockReturnValueOnce(
      failingStream(midStreamDrop(), { partial: partialMessage("claude-sonnet-5-5"), requestId: "req_fb" }),
    );
    await expect(callStructured(args())).rejects.toBeInstanceOf(ClaudeApiError);
    expect(recordUsageMock).toHaveBeenCalledTimes(1);
    expect(recordUsageMock.mock.calls[0][0]).toMatchObject({
      model: "claude-sonnet-5-5",
      costUsd: costFromUsage("claude-sonnet-5-5", partialUsage).costUsd,
    });
  });

  it("records nothing when the call failed before the stream started (no snapshot)", async () => {
    const http400 = Anthropic.APIError.generate(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "bad" } },
      undefined,
      new Headers({ "request-id": "req_400" }),
    );
    streamCall.mockReturnValueOnce(failingStream(http400));
    await expect(callStructured(args())).rejects.toBeInstanceOf(ClaudeBadRequestError);

    streamCall.mockReturnValueOnce(failingStream(new Anthropic.APIConnectionError({ message: "x" })));
    await expect(callStructured(args())).rejects.toMatchObject({ code: "ai_unavailable" });

    // Headers in (request id known) but no message_start yet.
    streamCall.mockReturnValueOnce(failingStream(midStreamDrop(), { requestId: "req_nostart" }));
    await expect(callStructured(args())).rejects.toMatchObject({ requestId: "req_nostart" });

    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  it("records nothing when the deadline had already passed (no stream at all)", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(callStructured({ ...args(), signal: controller.signal })).rejects.toBeInstanceOf(
      ClaudeApiError,
    );
    expect(streamCall).not.toHaveBeenCalled();
    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  it("a throwing recordUsage does not mask the original classified error; logs a fixed string", async () => {
    recordUsageMock.mockRejectedValueOnce(new Error(`sink exploded ${SECRET_OUTPUT}`));
    const original = Anthropic.APIError.generate(
      529,
      { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
      undefined,
      new Headers({ "request-id": "req_529" }),
    );
    streamCall.mockReturnValueOnce(
      failingStream(original, { partial: partialMessage(), requestId: "req_529" }),
    );

    const err = await callStructured(args()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClaudeApiError);
    expect(err).toMatchObject({ code: "ai_unavailable", retryable: true, status: 529, requestId: "req_529" });
    expect((err as Error).cause).toBe(original);
    expect(recordUsageMock).toHaveBeenCalledTimes(1);
    expect(logLines).toContain("[claude] recording partial usage after a stream failure failed");
    expect(logLines.join("\n")).not.toContain(SECRET_OUTPUT);
  });

  it("our whole-attempt timeout firing after message_start records exactly one stream_failed row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // message_start arrived (partial snapshot set) but the stream never finishes.
      const stalled = {
        request_id: "req_stall",
        currentMessage: partialMessage(),
        finalMessage: () => new Promise<never>(() => {}),
        abort: vi.fn(),
      };
      streamCall.mockReturnValueOnce(stalled);
      const timeoutMs = CLAUDE_TASKS.critiqueResume.timeoutMs;

      const pending = callStructured(args()).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(stalled.abort).not.toHaveBeenCalled();
      expect(recordUsageMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const err = await pending;

      expect(err).toBeInstanceOf(ClaudeApiError);
      expect(err).toMatchObject({ code: "ai_unavailable", retryable: true, requestId: "req_stall" });
      expect((err as Error).message).toContain("timed out");
      expect(stalled.abort).toHaveBeenCalledTimes(1);
      expect(recordUsageMock).toHaveBeenCalledTimes(1);
      expect(recordUsageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-opus-5-5",
          inputTokens: 4_000,
          outputTokens: 1,
          cacheReadTokens: 2_000,
          cacheWriteTokens: 500,
          costUsd: costFromUsage("claude-opus-5-5", partialUsage).costUsd,
          stopReason: PARTIAL_USAGE_STOP_REASON,
          requestId: "req_stall",
          userId: "user-9",
        }),
      );

      // Nothing more is recorded later (no second row from a late settle or timer).
      await vi.advanceTimersByTimeAsync(timeoutMs * 2);
      expect(recordUsageMock).toHaveBeenCalledTimes(1);
      expect(logLines.join("\n")).not.toContain(SECRET_OUTPUT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a snapshot without usage is skipped, not a crash", async () => {
    streamCall.mockReturnValueOnce(
      failingStream(midStreamDrop(), { partial: { model: "claude-opus-5-5" }, requestId: "req_nousage" }),
    );
    await expect(callStructured(args())).rejects.toMatchObject({ requestId: "req_nousage" });
    expect(recordUsageMock).not.toHaveBeenCalled();
  });
});
