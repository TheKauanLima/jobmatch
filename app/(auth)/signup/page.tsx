"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      });

      if (signUpError) {
        setError(signUpError.message);
        return;
      }

      // If email confirmation is enabled, Supabase returns a user with no
      // active session — the account exists but can't log in yet. If
      // confirmation is disabled, a session comes back immediately and we
      // can go straight to the dashboard.
      if (data.session) {
        router.push("/dashboard");
        router.refresh();
        return;
      }

      setConfirmationSent(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (confirmationSent) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-24">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          Check your email
        </h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          We sent a confirmation link to <span className="font-medium text-zinc-900">{email}</span>.
          Follow the link to activate your account, then log in.
        </p>
        <Link
          href="/login"
          className="mt-6 text-sm font-medium text-zinc-900 underline underline-offset-2"
        >
          Back to log in
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        Sign up
      </h1>
      <p className="mt-2 text-sm text-zinc-600">
        Create an account to upload your resume and start matching.
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
        <Input
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        <Button type="submit" loading={loading} className="mt-2 w-full">
          Sign up
        </Button>
      </form>

      <p className="mt-6 text-sm text-zinc-600">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-zinc-900 underline underline-offset-2">
          Log in
        </Link>
      </p>
    </div>
  );
}
