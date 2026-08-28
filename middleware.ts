import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Route prefixes that require a signed-in user. Subpaths are protected too
 * (checked via a "/prefix" or "/prefix/..." match below).
 */
const PROTECTED_PATHS = ["/dashboard", "/resumes", "/jobs", "/matches"];

/** Auth-only pages that a signed-in user shouldn't see again. */
const AUTH_PATHS = ["/login", "/signup"];

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Refreshes the Supabase auth session on every request that isn't a static
 * asset, then applies route protection:
 * - Unauthenticated users hitting a protected path are redirected to
 *   `/login`.
 * - Authenticated users hitting `/login` or `/signup` are redirected to
 *   `/dashboard`.
 *
 * This keeps the session cookie valid so Server Components and Route
 * Handlers see a signed-in user without each of them needing to refresh it
 * themselves.
 */
export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // Resolving the session is wrapped defensively: `createServerClient`
  // validates its args eagerly and throws synchronously if the Supabase env
  // vars are missing/invalid, and `getUser()` can reject on a transient
  // Supabase Auth outage/timeout. Since this middleware's matcher covers
  // effectively every route, an uncaught failure here would 500 the entire
  // site — including the public "/" landing page — rather than just the
  // routes that actually need auth. Any failure here is treated the same
  // way `lib/auth/session.ts`'s `getSession()` treats a soft auth error:
  // fall back to "no session" and let route protection below redirect
  // protected paths to `/login` as if logged out, while public/auth pages
  // still render normally.
  let user = null;

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value),
            );
            supabaseResponse = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options),
            );
          },
        },
      },
    );

    // IMPORTANT: Avoid writing logic between createServerClient and
    // supabase.auth.getUser(). A simple mistake could make it very hard to
    // debug issues with users being randomly logged out.
    const {
      data: { user: fetchedUser },
      error,
    } = await supabase.auth.getUser();

    if (!error) {
      user = fetchedUser;
    }
  } catch (err) {
    // Never log request/cookie contents (could contain session tokens) —
    // just enough to see this happened and why, in server logs.
    console.error(
      "middleware: failed to resolve Supabase session, treating as logged out:",
      err instanceof Error ? err.message : err,
    );
    user = null;
  }

  const { pathname } = request.nextUrl;

  if (!user && matchesPath(pathname, PROTECTED_PATHS)) {
    const redirectUrl = new URL("/login", request.url);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && matchesPath(pathname, AUTH_PATHS)) {
    const redirectUrl = new URL("/dashboard", request.url);
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt
     * - static asset file extensions
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
