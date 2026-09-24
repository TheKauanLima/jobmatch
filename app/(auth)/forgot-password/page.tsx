"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      // `redirectTo` is unused by the actual reset flow now (the email
      // template links straight to /auth/confirm, see
      // app/auth/confirm/route.ts), but harmless to keep passing — Supabase
      // still records it as the allowed post-verification redirect target.
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });

      // Always show the same "check your email" success state regardless of
      // what Supabase's API returns here — including a `429
      // over_email_send_rate_limit` error, which Supabase ONLY returns for
      // an email that already has a real account (an unknown email is never
      // rate-limited, since no email is ever sent for it). Branching on that
      // error would let an attacker distinguish real accounts from fake ones
      // by how fast they re-submit the same address. Any response FROM
      // Supabase's API — success or error — means the request reached
      // Supabase and got a real answer, so it's treated identically here.
      //
      // A thrown exception is different: that means the call never
      // completed (network failure, client misconfiguration, etc.), not an
      // answer from Supabase about the email's existence — so it's safe,
      // and more honest to the user, to show a distinct failure state for
      // that case only (see the catch block below).
      setSubmitted(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-24">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Check your email
        </h1>
        <p className="mt-3 text-sm leading-6 text-fg-muted">
          If an account exists for <span className="font-medium text-fg">{email}</span>,
          we sent a link to reset your password. Follow the link to choose a
          new password.
        </p>
        <Link
          href="/login"
          className="mt-6 text-sm font-medium text-fg underline underline-offset-2"
        >
          Back to log in
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Forgot password?
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        Enter your email and we&apos;ll send you a link to reset your
        password.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
        <Input
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
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
          Send reset link
        </Button>
      </form>

      <p className="mt-6 text-sm text-fg-muted">
        Remembered your password?{" "}
        <Link href="/login" className="font-medium text-fg underline underline-offset-2">
          Log in
        </Link>
      </p>
    </div>
  );
}
