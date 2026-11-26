import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { UsageLimits } from "@/components/settings/UsageLimits";
import { DeleteAccountForm } from "@/components/settings/DeleteAccountForm";

export const metadata: Metadata = {
  title: "Settings · Kalify",
};

/**
 * Account settings (docs/ARCHITECTURE.md §13.14, M1.4b): daily usage
 * limits and self-serve account deletion. Signed-in only: `middleware.ts`
 * redirects signed-out visitors, and this page re-checks the session the
 * same way every other protected page does.
 */
export default async function SettingsPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Settings
      </h1>
      {session.user.email && (
        <p className="mt-2 text-sm text-fg-muted">
          Signed in as{" "}
          <span className="break-all font-medium text-fg">{session.user.email}</span>
        </p>
      )}

      <section
        aria-labelledby="usage-limits-heading"
        className="mt-8 rounded-lg border border-border bg-surface p-4 sm:p-6"
      >
        <h2
          id="usage-limits-heading"
          className="text-lg font-semibold tracking-tight text-fg"
        >
          Daily usage limits
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          Limits keep the service available for every student. Usage resets
          every day at 00:00 UTC.
        </p>
        <div className="mt-5">
          <UsageLimits />
        </div>
      </section>

      <section
        aria-labelledby="delete-account-heading"
        className="mt-8 rounded-lg border border-danger-border bg-surface p-4 sm:p-6"
      >
        <h2
          id="delete-account-heading"
          className="text-lg font-semibold tracking-tight text-danger-fg"
        >
          Delete account
        </h2>
        <div className="mt-3">
          <DeleteAccountForm />
        </div>
      </section>
    </div>
  );
}
