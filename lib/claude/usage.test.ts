import { afterEach, describe, expect, it, vi } from "vitest";

import {
  costFromUsage,
  lookupPrice,
  PRICES,
  recordUsage,
  setUsageSink,
  summarizeUsage,
  UNKNOWN_MODEL_PRICE,
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

  it("covers the refusal-fallback targets at their list prices", () => {
    expect(PRICES["claude-opus-5"]).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(PRICES["claude-sonnet-5"]).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(PRICES["claude-opus-4-8"]).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
  });

  it("UNKNOWN_MODEL_PRICE is a ceiling: >= every list input price AND every list output price", () => {
    for (const [model, price] of Object.entries(PRICES)) {
      expect(UNKNOWN_MODEL_PRICE.inputPerMTok, model).toBeGreaterThanOrEqual(price.inputPerMTok);
      expect(UNKNOWN_MODEL_PRICE.outputPerMTok, model).toBeGreaterThanOrEqual(price.outputPerMTok);
    }
    expect(UNKNOWN_MODEL_PRICE.inputPerMTok).toBeGreaterThanOrEqual(5);
    expect(UNKNOWN_MODEL_PRICE.outputPerMTok).toBeGreaterThanOrEqual(25);
  });

  it("matches exact ids and dated snapshots of them", () => {
    expect(lookupPrice("claude-opus-5-5")).toEqual(PRICES["claude-opus-5-5"]);
    expect(lookupPrice("claude-opus-5")).toEqual(PRICES["claude-opus-5"]);
    expect(lookupPrice("claude-opus-5-5-20261101")).toEqual(PRICES["claude-opus-5-5"]);
    expect(lookupPrice("claude-opus-5-20260115")).toEqual(PRICES["claude-opus-5"]);
    expect(lookupPrice("claude-opus-4-8-20251201")).toEqual(PRICES["claude-opus-4-8"]);
  });

  it.each([
    "claude-opus-5-6", // a future model must NOT price as claude-opus-5
    "claude-opus-5-5-fast",
    "claude-opus-5-2026",
    "claude-opus-5-202611011",
    "claude-sonnet-5-5-latest",
    "claude-opus",
    "some-other-model",
    "toString", // no prototype lookups
    "constructor",
  ])("treats %j as unknown (null)", (model) => {
    expect(lookupPrice(model)).toBeNull();
  });

  it("a near-miss model id is priced at the ceiling with priceKnown: false", () => {
    expect(
      costFromUsage("claude-opus-5-6", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).toEqual({ costUsd: 30, priceKnown: false });
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

  it("prices an unknown model at the explicit ceiling ($5/$25) and flags it", () => {
    expect(
      costFromUsage("claude-future-9", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).toEqual({ costUsd: 30, priceKnown: false });
  });

  it("prices a fallback hop served by claude-opus-4-8 at $5/$25", () => {
    const { costUsd, priceKnown } = costFromUsage("claude-opus-4-8", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 0 },
        {
          type: "fallback_message",
          model: "claude-opus-4-8",
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
        },
      ],
    });
    // declined Opus 5.5 hop: 1M in * $4; served Opus 4.8 hop: 1M in * $5 + 1M out * $25
    expect(costUsd).toBe(4 + 5 + 25);
    expect(priceKnown).toBe(true);
  });

  it("flags priceKnown: false if any hop's model is unknown", () => {
    const { priceKnown } = costFromUsage("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: 1, output_tokens: 0 },
        { type: "fallback_message", model: "claude-mystery-1", input_tokens: 1, output_tokens: 1 },
      ],
    });
    expect(priceKnown).toBe(false);
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
