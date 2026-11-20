import { cookies } from "next/headers";

import { createClient } from "@/lib/supabase/server";

/**
 * Signs the caller out by clearing their Supabase session cookies
 * (docs/ARCHITECTURE.md §13.13.7 step 5). Only valid inside a Route Handler
 * or Server Function — that is where Next.js allows cookie writes.
 *
 * Two layers, because this runs right after the account was deleted and the
 * user must not be left holding session cookies either way:
 *   1. `supabase.auth.signOut({ scope: "local" })` on the cookie-bound server
 *      client. supabase-js removes the local session (→ `setAll` expires the
 *      auth cookies) even when the Auth server answers 401/403/404 because
 *      the user no longer exists.
 *   2. Belt and braces: expire every remaining request cookie that matches
 *      the `@supabase/ssr` auth-cookie naming scheme
 *      (`sb-<project-ref>-auth-token`, its `.N` chunks, and the PKCE
 *      `-code-verifier`), in case step 1 threw before writing cookies.
 *
 * Never throws: by the time this runs the account is already gone, so a
 * cookie-clearing hiccup must not turn a successful deletion into an error.
 * The leftover JWT (if any) belongs to a deleted user and is rejected by
 * `getUser()` everywhere (see `lib/auth/session.ts`).
 */
export async function clearAuthSession(): Promise<void> {
  try {
    const supabase = await createClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch (err) {
    console.error(
      "clearAuthSession: signOut failed; falling back to cookie expiry:",
      err instanceof Error ? err.name : "unknown error",
    );
  }

  try {
    const cookieStore = await cookies();
    for (const { name } of cookieStore.getAll()) {
      if (isSupabaseAuthCookieName(name)) {
        cookieStore.set({ name, value: "", maxAge: 0, path: "/" });
      }
    }
  } catch (err) {
    console.error(
      "clearAuthSession: failed to expire auth cookies:",
      err instanceof Error ? err.name : "unknown error",
    );
  }
}

const SUPABASE_AUTH_COOKIE_RE =
  /^sb-[^.]+-auth-token(?:-code-verifier)?(?:\.\d+)?$/;

/** True for `@supabase/ssr` session cookie names (incl. chunks). */
export function isSupabaseAuthCookieName(name: string): boolean {
  return SUPABASE_AUTH_COOKIE_RE.test(name);
}
