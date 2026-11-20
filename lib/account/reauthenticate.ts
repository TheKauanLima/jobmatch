import { createClient, isAuthApiError } from "@supabase/supabase-js";

import type { Database } from "@/types/database";

/**
 * Password re-authentication for destructive account actions
 * (docs/ARCHITECTURE.md §13.13.7 step 1).
 *
 * The password is checked with `signInWithPassword` on a **throwaway,
 * non-cookie** client: plain `@supabase/supabase-js` `createClient` with the
 * anon key and `persistSession: false`, so the session it creates lives only
 * in this client's memory. It never touches the caller's cookies, so the
 * caller's real session is not replaced, refreshed, or signed out by this
 * check. The throwaway session is then revoked server-side (best effort) so
 * a failed deletion later in the flow doesn't leave a stray session behind.
 *
 * PII: neither the email nor the password is logged, returned, or included
 * in any error message from this module.
 */

/**
 * - `ok`: the password is correct for this user.
 * - `invalid`: Supabase Auth rejected the credentials (wrong password, or an
 *   account state that blocks password sign-in). Maps to `403 reauth_failed`.
 * - `unavailable`: the check could not be completed (network error, Auth
 *   5xx, Auth rate limit). Not the user's fault, so it is NOT reported as a
 *   wrong password; maps to `500`.
 */
export type ReauthOutcome = "ok" | "invalid" | "unavailable";

/**
 * Auth API statuses that mean "these credentials were rejected". Everything
 * else (429 rate limit, 5xx, network failures surfaced as
 * `AuthRetryableFetchError`) is treated as `unavailable`.
 */
const CREDENTIAL_REJECTED_STATUSES = new Set([400, 401, 403, 422]);

/** Builds the throwaway client. Exported for tests only. */
export function createReauthClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "createReauthClient: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must both be set.",
    );
  }

  return createClient<Database>(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Verifies `password` for the user identified by `userId`/`email`. `email`
 * must come from the server-verified session (`requireSession()`), never from
 * request input. Returns `invalid` when the session user has no email (no
 * password to check against) or when Auth signs in a different user id than
 * the session's (should be impossible; defense in depth).
 *
 * Throws only if the Supabase env vars are missing (a deployment error).
 */
export async function verifyPassword(params: {
  userId: string;
  email: string | null | undefined;
  password: string;
}): Promise<ReauthOutcome> {
  const { userId, email, password } = params;

  if (!email) {
    return "invalid";
  }

  const client = createReauthClient();

  let outcome: ReauthOutcome;
  try {
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      outcome =
        isAuthApiError(error) && CREDENTIAL_REJECTED_STATUSES.has(error.status)
          ? "invalid"
          : "unavailable";
    } else if (!data.user || data.user.id !== userId) {
      outcome = "invalid";
    } else {
      outcome = "ok";
    }
  } catch {
    // supabase-js returns errors rather than throwing, but a thrown error
    // here (e.g. a fetch-level failure) must never be mistaken for a correct
    // password, and must never be logged with its (credential-bearing)
    // request context.
    return "unavailable";
  }

  if (outcome === "ok") {
    // Revoke the throwaway session server-side so it can't outlive this
    // request (matters when a later deletion step fails and the account
    // survives). `scope: "local"` revokes only this one session — the
    // caller's cookie session is untouched. Best effort: a failure here
    // doesn't change the verification result.
    try {
      await client.auth.signOut({ scope: "local" });
    } catch {
      // ignore
    }
  }

  return outcome;
}
