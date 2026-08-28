import { headers } from "next/headers";

/**
 * Server-side fetch helper for calling this app's own `/api/*` route
 * handlers from Server Components. `fetch` on the server needs an absolute
 * URL, and the route handlers authenticate via the session cookie (see
 * `lib/auth/session.ts`), so this builds the origin from the incoming
 * request's headers and forwards the cookie header along.
 *
 * Kept outside `lib/supabase/queries/*` deliberately — this talks to our own
 * API routes over HTTP (matching the documented contracts in
 * docs/ARCHITECTURE.md §2), not directly to Postgres.
 */
export async function serverFetch(path: string, init: RequestInit = {}) {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const protocol = headerList.get("x-forwarded-proto") ?? "http";
  const cookie = headerList.get("cookie") ?? "";

  if (!host) {
    throw new Error("Unable to determine request host for server-side fetch.");
  }

  return fetch(`${protocol}://${host}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      cookie,
    },
    cache: "no-store",
  });
}
