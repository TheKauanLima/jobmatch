import { afterEach, describe, expect, it, vi } from "vitest";

import {
  costFromUsage,
  lookupPrice,
  PRICES,
  recordUsage,
  setUsageSink,
  summarizeUsage,
  type UsageEvent,
} from "@/lib/claude/usage";

const event: UsageEvent = {
  provider: "anthropic",
  operation: "analyzeResume",
  model: "claude-opus-5-5",
  isBatch: false,
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.000044,
  stopReason: "end_turn",
  requestId: "req_1",
  userId: "user-1",
  taskId: null,
  taskAttempt: null,
};

afterEach(() => {
  setUsageSink(null);
  vi.restoreAllMocks();
});

describe("PRICES / lookupPrice (§13.17)", () => {
  it("has the stated per-MTok prices", () => {
    expect(PRICES["claude-opus-5-5"]).toEqual({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(PRICES["claude-sonnet-5-5"]).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(PRICES["claude-haiku-5-5"]).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
  });

  it("prices dated snapshot ids like their alias, and returns null for unknown models", () => {
    expect(lookupPrice("claude-opus-5-5-20261101")).toEqual(PRICES["claude-opus-5-5"]);
    expect(lookupPrice("claude-opus-5")).toBeNull();
    expect(lookupPrice("some-other-model")).toBeNull();
  });
});

describe("costFromUsage", () => {
  it("prices input and output (thinking is included in output_tokens)", () => {
    // 1M in * $4 + 1M out * $20
    expect(
      costFromUsage("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).toEqual({ costUsd: 24, priceKnown: true });
  });

  it("matches the live M1.1 analyze call (315 in, 847 out, 1727 cache-write)", () => {
    const { costUsd } = costFromUsage("claude-opus-5-5", {
      input_tokens: 315,
      output_tokens: 847,
      cache_creation_input_tokens: 1727,
      cache_read_input_tokens: 0,
    });
    // 315*4e-6 + 1727*1.25*4e-6 + 847*20e-6
    expect(costUsd).toBe(0.026835);
  });

  it("prices cache reads at 0.1x and 1h cache writes at 2x input", () => {
    const { costUsd } = costFromUsage("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 },
    });
    expect(costUsd).toBe(0.4 + 8);
  });

  it("applies the 50% batch discount", () => {
    expect(
      costFromUsage(
        "claude-opus-5-5",
        { input_tokens: 1_000_000, output_tokens: 0 },
        { isBatch: true },
      ).costUsd,
    ).toBe(2);
  });

  it("prices each hop at its own model when the refusal fallback served the response", () => {
    const { costUsd, priceKnown } = costFromUsage("claude-sonnet-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 0 },
        {
          type: "fallback_message",
          model: "claude-sonnet-5-5",
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
        },
      ],
    });
    expect(costUsd).toBe(4 + 2 + 10);
    expect(priceKnown).toBe(true);
  });

  it("treats a null iteration model as the response model", () => {
    const { costUsd } = costFromUsage("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [
        { type: "message", model: null, input_tokens: 1_000_000, output_tokens: 0 },
        { type: "fallback_message", model: null, input_tokens: 1_000_000, output_tokens: 0 },
      ],
    });
    expect(costUsd).toBe(8);
  });

  it("uses top-level counts when there is a single iteration", () => {
    const { costUsd } = costFromUsage("claude-opus-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      iterations: [{ type: "message", model: null, input_tokens: 1_000_000, output_tokens: 0 }],
    });
    expect(costUsd).toBe(4);
  });

  it("prices an unknown model at the most expensive known rate and flags it", () => {
    expect(
      costFromUsage("claude-future-9", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).toEqual({ costUsd: 24, priceKnown: false });
  });

  it("ignores null/negative/non-finite counts", () => {
    expect(
      costFromUsage("claude-opus-5-5", {
        input_tokens: -5,
        output_tokens: Number.NaN,
        cache_read_input_tokens: null,
      }).costUsd,
    ).toBe(0);
  });
});

describe("summarizeUsage", () => {
  it("returns token counts plus cost", () => {
    expect(
      summarizeUsage("claude-opus-5-5", {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      costUsd: 0.000652,
      priceKnown: true,
    });
  });
});

describe("usage sink", () => {
  it("is a no-op by default", async () => {
    await expect(recordUsage(event)).resolves.toBeUndefined();
  });

  it("delivers events to the registered sink and can be reset", async () => {
    const sink = vi.fn();
    setUsageSink(sink);
    await recordUsage(event);
    expect(sink).toHaveBeenCalledWith(event);

    setUsageSink(null);
    await recordUsage(event);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("awaits async sinks", async () => {
    const order: string[] = [];
    setUsageSink(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("sink");
    });
    await recordUsage(event);
    order.push("after");
    expect(order).toEqual(["sink", "after"]);
  });

  it("never throws when the sink fails, and logs no payload content", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setUsageSink(() => {
      throw new Error("db down: secret detail");
    });
    await expect(recordUsage(event)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret detail");
  });

  it("is shared process-wide (survives duplicate module instances)", async () => {
    const sink = vi.fn();
    setUsageSink(sink);
    vi.resetModules();
    const fresh = await import("@/lib/claude/usage");
    await fresh.recordUsage(event);
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
