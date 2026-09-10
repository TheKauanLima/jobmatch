import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";

/**
 * Service-role Supabase client — bypasses Row Level Security entirely.
 * Server-only, and only for trusted maintenance code with no per-request
 * user session to scope queries by (e.g. the external job-listing sync in
 * `lib/jobs/`, triggered by a cron route rather than a signed-in user). Per
 * docs/ARCHITECTURE.md §3, this must never be imported by a route handler
 * that echoes user-supplied filters — every caller of this client is
 * responsible for its own authorization check before using it (see
 * `app/api/cron/sync-jobs/route.ts` for the pattern: a shared-secret check,
 * not a user session).
 *
 * Deliberately built on plain `@supabase/supabase-js` `createClient`, not
 * `@supabase/ssr`'s `createServerClient` — there is no request/cookie
 * session to read or refresh here, and `auth.persistSession`/`autoRefreshToken`
 * are disabled since this client is created fresh per call with no session of
 * its own to persist.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "createAdminClient: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.",
    );
  }

  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
