import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_DELETED_URL,
  ACCOUNT_SIGNED_OUT_URL,
  DELETE_ACCOUNT_COPY,
  interpretDeleteAccountResponse,
  outcomeToFormResult,
  rateLimitedMessage,
  requestAccountDeletion,
  validateDeleteAccountInput,
  type DeleteAccountOutcome,
} from "@/lib/client/accountDeletion";
import { formatLocalDateTime } from "@/lib/client/formatDateTime";

const PASSWORD = "correct horse battery staple";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchReturning(response: Response) {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

async function submit(response: Response) {
  return outcomeToFormResult(
    await requestAccountDeletion(PASSWORD, fetchReturning(response)),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestAccountDeletion request", () => {
  it("sends DELETE /api/account with the password and confirm:'DELETE'", async () => {
    const fetchImpl = fetchReturning(new Response(null, { status: 204 }));
    await requestAccountDeletion(PASSWORD, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/account");
    expect(init?.method).toBe("DELETE");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      password: PASSWORD,
      confirm: "DELETE",
    });
  });
});

describe("response mapping (ARCHITECTURE §13.13.7)", () => {
  it("204 → navigates to / with the deleted confirmation", async () => {
    expect(await submit(new Response(null, { status: 204 }))).toEqual({
      type: "navigate",
      url: ACCOUNT_DELETED_URL,
    });
    expect(ACCOUNT_DELETED_URL).toBe("/?account=deleted");
  });

  it("401 → treated as already deleted/signed out, not an error", async () => {
    const result = await submit(jsonResponse(401, { error: "Unauthorized" }));
    expect(result).toEqual({ type: "navigate", url: ACCOUNT_SIGNED_OUT_URL });
    expect(ACCOUNT_SIGNED_OUT_URL.startsWith("/?")).toBe(true);
  });

  it("401 with no/invalid body (e.g. a replay after a lost 204) still navigates", async () => {
    const result = await submit(new Response("not json", { status: 401 }));
    expect(result.type).toBe("navigate");
  });

  it("403 reauth_failed → 'Incorrect password' on the password field", async () => {
    const result = await submit(
      jsonResponse(403, { error: "Incorrect password.", code: "reauth_failed" }),
    );
    expect(result).toEqual({
      type: "error",
      target: "password",
      message: "Incorrect password.",
    });
  });

  it("429 → 'Too many attempts, try again after <retry_after>' in local time", async () => {
    const retryAfter = "2026-11-13T00:00:00.000Z";
    const result = await submit(
      jsonResponse(429, {
        error: "Too many password attempts today.",
        code: "rate_limited",
        kind: "account_reauth",
        retry_after: retryAfter,
      }),
    );
    expect(result).toEqual({
      type: "error",
      target: "form",
      message: `Too many attempts. Try again after ${formatLocalDateTime(retryAfter)}.`,
    });
  });

  it("429 without a usable retry_after falls back to generic reset copy", async () => {
    for (const body of [
      { code: "rate_limited" },
      { code: "rate_limited", retry_after: "garbage" },
      { code: "rate_limited", retry_after: 123 },
    ]) {
      const result = await submit(jsonResponse(429, body));
      expect(result).toEqual({
        type: "error",
        target: "form",
        message: DELETE_ACCOUNT_COPY.rateLimitedFallback,
      });
    }
    const unparseable = await submit(new Response("<html>", { status: 429 }));
    expect(unparseable).toMatchObject({
      message: DELETE_ACCOUNT_COPY.rateLimitedFallback,
    });
  });

  it("500 → the shared 'account still exists' copy, verbatim", async () => {
    const result = await submit(
      jsonResponse(500, { error: "anything", code: "internal_error" }),
    );
    expect(result).toEqual({
      type: "error",
      target: "form",
      message:
        "We couldn't finish deleting your account. Your account still exists — please try again.",
    });
  });

  it("500 with an HTML body (platform failure, e.g. FUNCTION_INVOCATION_FAILED) → 'couldn't confirm', not 'still exists'", async () => {
    const result = await submit(
      new Response("<html><body>Internal Server Error</body></html>", {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }),
    );
    expect(result).toEqual({
      type: "error",
      target: "form",
      message: DELETE_ACCOUNT_COPY.uncertain,
    });
  });

  it.each([
    { error: "A server error has occurred", code: "FUNCTION_INVOCATION_FAILED" },
    { error: "no code" },
    { code: "INTERNAL_ERROR" },
    null,
    ["internal_error"],
  ])("500 with non-matching JSON %j → 'couldn't confirm'", async (body) => {
    const result = await submit(jsonResponse(500, body));
    expect(result).toMatchObject({
      type: "error",
      message: DELETE_ACCOUNT_COPY.uncertain,
    });
  });

  it("the 'couldn't confirm' copy doesn't blame the connection failing", () => {
    expect(DELETE_ACCOUNT_COPY.uncertain).toBe(
      "We couldn't confirm whether your account was deleted. Check your connection and try again.",
    );
  });

  it("400 validation_failed → a fixed inline message (server text is not echoed)", async () => {
    const result = await submit(
      jsonResponse(400, { error: "server says hi", code: "validation_failed" }),
    );
    expect(result).toEqual({
      type: "error",
      target: "form",
      message: DELETE_ACCOUNT_COPY.invalidRequest,
    });
  });

  it("network failure → 'couldn't confirm' copy that doesn't claim the account still exists", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const outcome = await requestAccountDeletion(PASSWORD, fetchImpl);
    expect(outcome).toEqual({ kind: "uncertain" });
    const result = outcomeToFormResult(outcome);
    expect(result).toEqual({
      type: "error",
      target: "form",
      message: DELETE_ACCOUNT_COPY.uncertain,
    });
    expect(DELETE_ACCOUNT_COPY.uncertain).not.toMatch(/still exists/i);
  });

  it.each([404, 405, 502, 503, 504])(
    "unexpected status %i → the 'couldn't confirm' copy",
    async (status) => {
      const result = await submit(new Response("", { status }));
      expect(result).toMatchObject({
        type: "error",
        message: DELETE_ACCOUNT_COPY.uncertain,
      });
    },
  );

  it("only reads the body for 429 and 500", async () => {
    for (const status of [204, 401, 403, 400]) {
      const json = vi.fn();
      await interpretDeleteAccountResponse({ status, json });
      expect(json).not.toHaveBeenCalled();
    }
  });

  it("maps every outcome kind (exhaustive)", () => {
    const outcomes: DeleteAccountOutcome[] = [
      { kind: "deleted" },
      { kind: "signed_out" },
      { kind: "incorrect_password" },
      { kind: "rate_limited", retryAfter: null },
      { kind: "server_error" },
      { kind: "invalid_request" },
      { kind: "uncertain" },
    ];
    for (const outcome of outcomes) {
      expect(outcomeToFormResult(outcome)).toBeDefined();
    }
  });
});

describe("password handling", () => {
  it("never logs the password, whatever the outcome", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const responses = [
      new Response(null, { status: 204 }),
      jsonResponse(401, { error: "Unauthorized" }),
      jsonResponse(403, { code: "reauth_failed" }),
      jsonResponse(429, { retry_after: "2026-11-13T00:00:00Z" }),
      jsonResponse(500, { code: "internal_error" }),
      jsonResponse(400, { code: "validation_failed" }),
    ];
    for (const response of responses) {
      const result = await submit(response);
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    }
    await requestAccountDeletion(
      PASSWORD,
      vi.fn<typeof fetch>().mockRejectedValue(new Error(PASSWORD)),
    );
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("validateDeleteAccountInput", () => {
  it("requires DELETE exactly (case-sensitive) before the password", () => {
    expect(validateDeleteAccountInput({ confirm: "", password: "" })).toEqual({
      target: "confirm",
      message: expect.stringContaining("DELETE"),
    });
    expect(
      validateDeleteAccountInput({ confirm: "delete", password: "x" }),
    ).toMatchObject({ target: "confirm" });
    expect(
      validateDeleteAccountInput({ confirm: " DELETE", password: "x" }),
    ).toMatchObject({ target: "confirm" });
  });

  it("requires a password", () => {
    expect(
      validateDeleteAccountInput({ confirm: "DELETE", password: "" }),
    ).toEqual({ target: "password", message: "Enter your password." });
  });

  it("passes valid input", () => {
    expect(
      validateDeleteAccountInput({ confirm: "DELETE", password: "x" }),
    ).toBeNull();
  });
});

describe("rateLimitedMessage", () => {
  it("formats retry_after with the time zone shown", () => {
    const message = rateLimitedMessage("2026-11-13T00:00:00Z");
    expect(message.startsWith("Too many attempts. Try again after ")).toBe(true);
    expect(message).toContain("2026");
  });
});
