"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

// `?reset=success` is a static, client-only value (it never changes during
// the page's lifetime, and only exists post-hydration since it comes from
// `window.location`) — read via useSyncExternalStore rather than
// useState+useEffect, same idiom as components/ThemeToggle.tsx, so the
// server-rendered paint (no banner) and the client's first paint agree
// without a synchronous setState-in-effect.
function subscribeNoop() {
  return () => {};
}

function getResetSuccessSnapshot() {
  return new URLSearchParams(window.location.search).get("reset") === "success";
}

function getResetSuccessServerSnapshot() {
  return false;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const resetSuccess = useSyncExternalStore(
    subscribeNoop,
    getResetSuccessSnapshot,
    getResetSuccessServerSnapshot,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        setError(signInError.message);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Log in
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        Welcome back. Log in to view your resumes and matches.
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
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <div className="flex justify-end">
          <Link
            href="/forgot-password"
            className="text-sm font-medium text-fg underline underline-offset-2"
          >
            Forgot password?
          </Link>
        </div>

        {resetSuccess && (
          <p className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success-fg">
            Password updated. Log in with your new password.
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
          >
            {error}
          </p>
        )}

        <Button type="submit" loading={loading} className="mt-2 w-full">
          Log in
        </Button>
      </form>

      <p className="mt-6 text-sm text-fg-muted">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-medium text-fg underline underline-offset-2">
          Sign up
        </Link>
      </p>
    </div>
  );
}
