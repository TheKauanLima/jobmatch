import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/types/database";

/**
 * Supabase client for use in Server Components, Route Handlers, and Server
 * Actions. Reads/writes the session via Next.js's cookie store so RLS
 * policies apply as the currently signed-in user.
 *
 * Must be called fresh (not module-level cached) inside each request scope,
 * per @supabase/ssr's recommended pattern for the App Router.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // `setAll` is called from a Server Component in some cases
            // (e.g. rendering a page). This can be ignored if there is
            // middleware refreshing the session on every request (see
            // middleware.ts) — cookie writes there keep sessions in sync.
          }
        },
      },
    },
  );
}
