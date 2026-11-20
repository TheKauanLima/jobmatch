import { describe, expect, it, vi } from "vitest";

import {
  consumeAccountReauthAttempt,
  getMyRateLimits,
  nextUtcMidnight,
  RateLimitRpcError,
} from "@/lib/rateLimit";

function rpcClient(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as never, rpc };
}

describe("nextUtcMidnight", () => {
  it("is the start of the next UTC day", () => {
    expect(nextUtcMidnight(new Date("2026-11-09T13:45:12.345Z"))).toBe(
      "2026-11-10T00:00:00.000Z",
    );
  });

  it("at exactly midnight, is the following midnight", () => {
    expect(nextUtcMidnight(new Date("2026-11-09T00:00:00.000Z"))).toBe(
      "2026-11-10T00:00:00.000Z",
    );
  });

  it("rolls over month and year ends", () => {
    expect(nextUtcMidnight(new Date("2026-12-31T23:59:59.999Z"))).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("consumeAccountReauthAttempt", () => {
  const now = new Date("2026-11-09T18:00:00.000Z");

  it("calls the no-argument RPC (it can only charge auth.uid())", async () => {
    const { client, rpc } = rpcClient({ data: true, error: null });

    await consumeAccountReauthAttempt(client, now);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("consume_account_reauth_attempt");
  });

  it("true → allowed", async () => {
    const { client } = rpcClient({ data: true, error: null });

    expect(await consumeAccountReauthAttempt(client, now)).toEqual({
      allowed: true,
    });
  });

  it("false → not allowed, retry after the next UTC midnight", async () => {
    const { client } = rpcClient({ data: false, error: null });

    expect(await consumeAccountReauthAttempt(client, now)).toEqual({
      allowed: false,
      retryAfter: "2026-11-10T00:00:00.000Z",
    });
  });

  it("an RPC error throws RateLimitRpcError (fails closed)", async () => {
    const { client } = rpcClient({
      data: null,
      error: { code: "42501", message: "unauthenticated" },
    });

    const err = await consumeAccountReauthAttempt(client, now).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitRpcError);
    expect(err.code).toBe("42501");
    expect(err.isUnauthenticated).toBe(true);
  });

  it.each([null, undefined, "true", 1, {}])(
    "a non-boolean result (%s) throws instead of allowing",
    async (data) => {
      const { client } = rpcClient({ data, error: null });

      await expect(consumeAccountReauthAttempt(client, now)).rejects.toBeInstanceOf(
        RateLimitRpcError,
      );
    },
  );

  it("a rejected RPC promise propagates (caller fails closed)", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("fetch failed"));

    await expect(
      consumeAccountReauthAttempt({ rpc } as never, now),
    ).rejects.toThrow("fetch failed");
  });
});

describe("getMyRateLimits", () => {
  it("returns every row with resets_at normalized to ISO", async () => {
    const { client, rpc } = rpcClient({
      data: [
        {
          kind: "account_reauth",
          daily_limit: 10,
          used_today: 3,
          resets_at: "2026-11-10T00:00:00+00:00",
        },
        {
          kind: "resume_report",
          daily_limit: 5,
          used_today: 0,
          resets_at: "2026-11-10T00:00:00+00:00",
        },
      ],
      error: null,
    });

    expect(await getMyRateLimits(client)).toEqual([
      {
        kind: "account_reauth",
        daily_limit: 10,
        used_today: 3,
        resets_at: "2026-11-10T00:00:00.000Z",
      },
      {
        kind: "resume_report",
        daily_limit: 5,
        used_today: 0,
        resets_at: "2026-11-10T00:00:00.000Z",
      },
    ]);
    expect(rpc).toHaveBeenCalledWith("get_my_rate_limits");
  });

  it("null data → empty list", async () => {
    const { client } = rpcClient({ data: null, error: null });

    expect(await getMyRateLimits(client)).toEqual([]);
  });

  it("an RPC error throws RateLimitRpcError with the Postgres code", async () => {
    const { client } = rpcClient({
      data: null,
      error: { code: "XX000", message: "boom" },
    });

    const err = await getMyRateLimits(client).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitRpcError);
    expect(err.code).toBe("XX000");
    expect(err.isUnauthenticated).toBe(false);
    expect(err.message).toContain("get_my_rate_limits");
  });
});
