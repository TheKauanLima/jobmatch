import { ACCOUNT_DELETE_CONFIRMATION } from "@/lib/validation/schemas";
import { formatLocalDateTime } from "@/lib/client/formatDateTime";

/**
 * Client-side request + response mapping for `DELETE /api/account`
 * (docs/ARCHITECTURE.md §13.13.7). Kept free of React so the mapping the
 * settings form relies on is unit-testable on its own; `DeleteAccountForm`
 * only renders what this returns.
 *
 * The password is only ever placed in the request body. Nothing here logs,
 * stores or echoes it.
 */

/** Where the form routes after a deletion outcome (§13.13.7 frontend rule). */
export const ACCOUNT_DELETED_URL = "/?account=deleted";
/**
 * `401` from the delete endpoint: the session no longer resolves. Per
 * §13.13.7 this is treated like success (most often a retry after a `204`
 * lost in transit), but routed with its own flag so the confirmation copy
 * stays truthful if the session simply ended some other way.
 */
export const ACCOUNT_SIGNED_OUT_URL = "/?account=signed_out";

export const DELETE_ACCOUNT_COPY = {
  incorrectPassword: "Incorrect password.",
  /** The shared §13.13.7 `500` copy, rendered verbatim. */
  serverError:
    "We couldn't finish deleting your account. Your account still exists — please try again.",
  rateLimitedFallback:
    "Too many attempts. Try again after the daily reset at 00:00 UTC.",
  invalidRequest:
    `We couldn't process that request. Check that you typed ${ACCOUNT_DELETE_CONFIRMATION} and entered your password, then try again.`,
  /**
   * Network failure or an unexpected status (e.g. a gateway timeout). The
   * request may or may not have reached the server, so this never claims
   * the account still exists. Retrying is safe: a completed deletion makes
   * the retry return `401`, which lands on the confirmation.
   */
  uncertain:
    "We couldn't confirm whether your account was deleted. Check your connection and try again.",
} as const;

export function rateLimitedMessage(retryAfter: string | null): string {
  const when = formatLocalDateTime(retryAfter);
  return when
    ? `Too many attempts. Try again after ${when}.`
    : DELETE_ACCOUNT_COPY.rateLimitedFallback;
}

export type DeleteAccountOutcome =
  | { kind: "deleted" }
  | { kind: "signed_out" }
  | { kind: "incorrect_password" }
  | { kind: "rate_limited"; retryAfter: string | null }
  | { kind: "server_error" }
  | { kind: "invalid_request" }
  | { kind: "uncertain" };

/**
 * Maps a `DELETE /api/account` response to an outcome, exactly per the
 * §13.13.7 responses table. Only `429` (for `retry_after`) and `500` (for `code`) read the body.
 */
export async function interpretDeleteAccountResponse(
  response: Pick<Response, "status" | "json">,
): Promise<DeleteAccountOutcome> {
  switch (response.status) {
    case 204:
      return { kind: "deleted" };
    case 401:
      return { kind: "signed_out" };
    case 403:
      return { kind: "incorrect_password" };
    case 429: {
      const body: unknown = await response.json().catch(() => null);
      const retryAfter =
        body !== null &&
        typeof body === "object" &&
        "retry_after" in body &&
        typeof body.retry_after === "string"
          ? body.retry_after
          : null;
      return { kind: "rate_limited", retryAfter };
    }
    case 500: {
      // Only the route's own 500 (code internal_error) guarantees the
      // account still exists. A platform 500 (e.g. Vercel
      // FUNCTION_INVOCATION_FAILED, non-JSON) could follow a completed
      // deletion, so it is reported as uncertain.
      const body: unknown = await response.json().catch(() => null);
      return body !== null &&
        typeof body === "object" &&
        "code" in body &&
        body.code === "internal_error"
        ? { kind: "server_error" }
        : { kind: "uncertain" };
    }
    case 400:
      return { kind: "invalid_request" };
    default:
      return { kind: "uncertain" };
  }
}

/** Sends the deletion request and maps the result. Never throws. */
export async function requestAccountDeletion(
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeleteAccountOutcome> {
  let response: Response;
  try {
    response = await fetchImpl("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, confirm: ACCOUNT_DELETE_CONFIRMATION }),
      cache: "no-store",
    });
  } catch {
    return { kind: "uncertain" };
  }
  return interpretDeleteAccountResponse(response);
}

/** Which input an error belongs to; `form` errors render in a summary box. */
export type DeleteAccountErrorTarget = "password" | "confirm" | "form";

export type DeleteAccountFormResult =
  | { type: "navigate"; url: string }
  | { type: "error"; target: DeleteAccountErrorTarget; message: string };

/** Turns an outcome into what the form does next. */
export function outcomeToFormResult(
  outcome: DeleteAccountOutcome,
): DeleteAccountFormResult {
  switch (outcome.kind) {
    case "deleted":
      return { type: "navigate", url: ACCOUNT_DELETED_URL };
    case "signed_out":
      return { type: "navigate", url: ACCOUNT_SIGNED_OUT_URL };
    case "incorrect_password":
      return {
        type: "error",
        target: "password",
        message: DELETE_ACCOUNT_COPY.incorrectPassword,
      };
    case "rate_limited":
      return {
        type: "error",
        target: "form",
        message: rateLimitedMessage(outcome.retryAfter),
      };
    case "server_error":
      return {
        type: "error",
        target: "form",
        message: DELETE_ACCOUNT_COPY.serverError,
      };
    case "invalid_request":
      return {
        type: "error",
        target: "form",
        message: DELETE_ACCOUNT_COPY.invalidRequest,
      };
    case "uncertain":
      return {
        type: "error",
        target: "form",
        message: DELETE_ACCOUNT_COPY.uncertain,
      };
  }
}

/**
 * Client-side checks run before any request, mirroring
 * `accountDeleteSchema` so obvious mistakes don't spend one of the user's
 * 10 daily `account_reauth` attempts. The confirmation is case-sensitive.
 */
export function validateDeleteAccountInput(input: {
  confirm: string;
  password: string;
}): { target: "confirm" | "password"; message: string } | null {
  if (input.confirm !== ACCOUNT_DELETE_CONFIRMATION) {
    return {
      target: "confirm",
      message: `Type ${ACCOUNT_DELETE_CONFIRMATION} in capital letters to confirm.`,
    };
  }
  if (input.password.length === 0) {
    return { target: "password", message: "Enter your password." };
  }
  return null;
}
