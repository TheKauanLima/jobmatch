"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

type SessionStatus = "checking" | "valid" | "invalid";

// `?error=invalid` is a static, client-only value set by app/auth/confirm/route.ts
// before it redirects here — read the same way login/page.tsx reads `?reset=success`
// (useSyncExternalStore over window.location, not next/navigation's useSearchParams)
// so this stays a plain client component with no Suspense-boundary requirement.
function subscribeNoop() {
  return () => {};
}

function getConfirmErrorSnapshot() {
  return new URLSearchParams(window.location.search).get("error") === "invalid";
}

function getConfirmErrorServerSnapshot() {
  return false;
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const hasConfirmError = useSyncExternalStore(
    subscribeNoop,
    getConfirmErrorSnapshot,
    getConfirmErrorServerSnapshot,
  );
  // Only tracks the outcome of the async `getSession()` check below —
  // `hasConfirmError` (known synchronously, before this ever needs to run)
  // is folded in separately when deriving the final status, so the effect
  // never needs to setState for that branch (see `sessionStatus` below).
  const [asyncSessionStatus, setAsyncSessionStatus] = useState<
    "checking" | "valid" | "invalid"
  >("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // By the time this page renders, `app/auth/confirm/route.ts` has already
    // run server-side: it exchanged the recovery link's `token_hash` for a
    // session via `verifyOtp` and wrote that session to cookies before
    // redirecting here (PKCE-flow, cookie-based — see that route's
    // docstring for why this replaced client-side hash-fragment detection).
    // So the check here is simply "is there already a valid session" — not
    // "wait for a PASSWORD_RECOVERY event from a URL fragment," which never
    // fires for a PKCE-flow client.
    //
    // `?error=invalid` (set by the confirm route itself when `verifyOtp`
    // fails) is handled without touching this state at all — see
    // `sessionStatus` below — so there's nothing to check/fetch for that
    // case.
    if (hasConfirmError) {
      return;
    }

    let cancelled = false;
    const supabase = createClient();

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      setAsyncSessionStatus(session ? "valid" : "invalid");
    });

    return () => {
      cancelled = true;
    };
  }, [hasConfirmError]);

  const sessionStatus: SessionStatus = hasConfirmError
    ? "invalid"
    : asyncSessionStatus;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);

    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });

      if (updateError) {
        setError(updateError.message);
        return;
      }

      // The recovery session isn't treated as a normal logged-in session
      // for this app — sign it out and send the user to log in fresh with
      // their new password, same as signup's "confirm, then log in" flow.
      await supabase.auth.signOut();
      router.push("/login?reset=success");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (sessionStatus === "checking") {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-24">
        <p className="text-sm text-fg-muted">Verifying your reset link…</p>
      </div>
    );
  }

  if (sessionStatus === "invalid") {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-24">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Link expired or invalid
        </h1>
        <p className="mt-3 text-sm leading-6 text-fg-muted">
          This password reset link is invalid or has expired. Reset links can
          only be used once. Request a new one to continue.
        </p>
        <Link
          href="/forgot-password"
          className="mt-6 text-sm font-medium text-fg underline underline-offset-2"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Set a new password
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        Choose a new password for your account.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
        <Input
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Input
          id="confirmPassword"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />

        {error && (
          <p
            role="alert"
            className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
          >
            {error}
          </p>
        )}

        <Button type="submit" loading={loading} className="mt-2 w-full">
          Update password
        </Button>
      </form>
    </div>
  );
}
