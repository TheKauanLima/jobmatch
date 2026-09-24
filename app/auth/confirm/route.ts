import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/**
 * Server-side email-link confirmation endpoint, used by every Supabase auth
 * email template that hands the user a `token_hash`/`type` pair instead of a
 * hash-fragment session (signup confirmation, magic link, and — the reason
 * this route exists — password recovery).
 *
 * Why this route exists at all: the browser Supabase client
 * (`lib/supabase/client.ts`) is created via `@supabase/ssr`'s
 * `createBrowserClient`, which hardcodes PKCE flow. A PKCE-flow client
 * cannot process an implicit-flow link (`#access_token=...&type=recovery`)
 * — `verifyOtp` here, called from the SERVER client
 * (`lib/supabase/server.ts`), is the PKCE-compatible replacement: it
 * exchanges the token server-side and writes the resulting session straight
 * to cookies, which is exactly what the rest of this app (cookie-based
 * sessions via `@supabase/ssr`) expects. See docs/ARCHITECTURE.md — this
 * route is intentionally the *only* place `verifyOtp` is called; every auth
 * email template must link here, never straight to a page.
 *
 * Never logs `token_hash` (it's a single-use credential — logging it would
 * be effectively logging a password-reset capability) or any other
 * user-identifying value from this request.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);

  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = normalizeNext(searchParams.get("next"));

  if (!token_hash || !type) {
    return NextResponse.redirect(withError(origin, next));
  }

  const supabase = await createClient();

  const { error } = await supabase.auth.verifyOtp({ token_hash, type });

  if (error) {
    return NextResponse.redirect(withError(origin, next));
  }

  return NextResponse.redirect(new URL(next, origin));
}

/**
 * `next` is attacker-influenceable (it's a query param on a publicly
 * shareable link). This used to be a prefix-based blocklist ("must start
 * with `/`, must not start with `//`"), which QA broke live with
 * `next=/\evil.com`: it passes an `is-a-relative-path` prefix check, but
 * WHATWG URL parsing (what `new URL(next, origin)` below actually uses)
 * treats `\` the same as `/` for special schemes like `http`, so it
 * resolves to `http://evil.com/` anyway — a full open redirect, including
 * on the success path with a real valid recovery session attached. A
 * blocklist can't keep up with parser quirks like this (backslash handling
 * today, who knows what tomorrow) so this isn't "add `\` to the blocklist"
 * — it's a strict allowlist instead. `next` only exists to send the user to
 * one specific place after email-link confirmation, so there is no reason
 * to accept anything other than that one known-safe value.
 */
const ALLOWED_NEXT_PATHS = new Set(["/reset-password"]);

function normalizeNext(next: string | null): string {
  const DEFAULT_NEXT = "/reset-password";

  if (next && ALLOWED_NEXT_PATHS.has(next)) {
    return next;
  }

  return DEFAULT_NEXT;
}

function withError(origin: string, next: string): URL {
  const url = new URL(next, origin);
  url.searchParams.set("error", "invalid");
  return url;
}
