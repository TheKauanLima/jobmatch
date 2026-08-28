import type { Session, User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/**
 * The authenticated identity for the current request: both the Supabase
 * `User` and the underlying `Session` (access/refresh tokens), for callers
 * that need one or the other.
 */
export type AuthSession = {
  user: User;
  session: Session;
};

/**
 * Typed error thrown by `requireSession()` so route handlers can turn it
 * into a `401 Unauthorized` response without string-matching on error
 * messages.
 */
export class UnauthorizedError extends Error {
  readonly status = 401 as const;

  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Returns the current authenticated session (user + session), or `null` if
 * there isn't one. Server-side only (Route Handlers, Server Components,
 * Server Actions) — uses the cookie-based client from `lib/supabase/server.ts`.
 *
 * Uses `supabase.auth.getUser()` as the authoritative check: unlike reading
 * the session straight off the cookie, `getUser()` revalidates the JWT
 * against the Supabase Auth server, so this is safe to call even if this
 * ends up running outside `middleware.ts`'s refresh cycle for some reason.
 */
export async function getSession(): Promise<AuthSession | null> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return null;
  }

  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError || !session) {
    return null;
  }

  return { user, session };
}

/**
 * Same as `getSession()`, but throws `UnauthorizedError` instead of
 * returning `null`. Intended for use at the top of API route handlers:
 *
 * ```ts
 * export async function GET() {
 *   let auth: AuthSession;
 *   try {
 *     auth = await requireSession();
 *   } catch (err) {
 *     if (err instanceof UnauthorizedError) {
 *       return NextResponse.json({ error: err.message }, { status: err.status });
 *     }
 *     throw err;
 *   }
 *   // ... use auth.user.id for RLS-scoped queries
 * }
 * ```
 */
export async function requireSession(): Promise<AuthSession> {
  const session = await getSession();

  if (!session) {
    throw new UnauthorizedError();
  }

  return session;
}
