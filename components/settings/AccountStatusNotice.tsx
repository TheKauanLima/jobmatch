"use client";

import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore } from "react";

export type AccountStatus = "deleted" | "signed_out";

/**
 * Copy for the confirmation shown on `/` after `DeleteAccountForm` leaves
 * the settings page (docs/ARCHITECTURE.md §13.13.7 frontend rule).
 * - `deleted`: the endpoint answered `204`.
 * - `signed_out`: it answered `401`. That's almost always a retry after a
 *   lost `204` (the account is already gone), so it's a confirmation, not an
 *   error. The copy stays truthful for the rare case where the session
 *   ended some other way.
 */
export const ACCOUNT_STATUS_COPY: Record<
  AccountStatus,
  { title: string; body: string }
> = {
  deleted: {
    title: "Your account has been deleted",
    body: "Your resumes, analyses, matches and private data have been removed, and you've been signed out.",
  },
  signed_out: {
    title: "You're signed out",
    body: "Your session ended while deleting your account, which usually means the deletion had already finished. If you can still log in, your account wasn't deleted and you can try again from Settings.",
  },
};

export function parseAccountStatus(search: string): AccountStatus | null {
  const value = new URLSearchParams(search).get("account");
  return value === "deleted" || value === "signed_out" ? value : null;
}

/**
 * Reads the `?account=` flag once and removes it from the URL with
 * `history.replaceState` (keeping Next.js's history state), so a reload,
 * a back/forward visit or a copied link never shows the notice again. The
 * caller keeps the returned status in React state for as long as the
 * notice is on screen. Exported (with injectable location/history) for
 * tests.
 */
export function consumeAccountStatusFlag(
  location: Pick<Location, "href">,
  history: Pick<History, "state" | "replaceState">,
): AccountStatus | null {
  const url = new URL(location.href);
  const status = parseAccountStatus(url.search);
  if (url.searchParams.has("account")) {
    url.searchParams.delete("account");
    history.replaceState(history.state, "", url);
  }
  return status;
}

/**
 * Tiny external store holding the status shown on this visit. `subscribe`
 * runs after mount (`/` is static, so the server and hydration passes see
 * `null`), reads and clears the URL flag, and notifies, so the status lives
 * outside the URL while the notice is up.
 *
 * The status is forgotten once nothing is subscribed (the page unmounted),
 * so a later client-side visit to `/` doesn't show it again. The reset is
 * deferred a tick because StrictMode unsubscribes and resubscribes
 * synchronously on mount, and the flag is already gone from the URL by the
 * second subscribe.
 */
export function createAccountStatusStore(
  readFlag: () => AccountStatus | null,
  defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0),
) {
  let status: AccountStatus | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      const flag = readFlag();
      if (flag) {
        status = flag;
        notify();
      }
      return () => {
        listeners.delete(listener);
        defer(() => {
          if (listeners.size === 0) status = null;
        });
      };
    },
    getSnapshot: () => status,
    getServerSnapshot: (): AccountStatus | null => null,
    dismiss() {
      status = null;
      notify();
    },
  };
}

const accountStatusStore = createAccountStatusStore(() =>
  consumeAccountStatusFlag(window.location, window.history),
);

export function AccountStatusNotice() {
  const status = useSyncExternalStore(
    accountStatusStore.subscribe,
    accountStatusStore.getSnapshot,
    accountStatusStore.getServerSnapshot,
  );

  if (!status) return null;

  return (
    <AccountStatusNoticeView
      status={status}
      onDismiss={accountStatusStore.dismiss}
    />
  );
}

/** Pure renderer; exported for tests. */
export function AccountStatusNoticeView({
  status,
  onDismiss,
}: {
  status: AccountStatus;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const copy = ACCOUNT_STATUS_COPY[status];

  // Move focus here on arrival so screen-reader users hear the outcome.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-6 sm:px-6 sm:pt-8">
      <div
        ref={ref}
        role="status"
        tabIndex={-1}
        className={`flex flex-col gap-3 rounded-md border px-4 py-3 text-sm focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:flex-row sm:items-start sm:justify-between ${
          status === "deleted"
            ? "border-success-border bg-success-bg text-success-fg"
            : "border-border bg-surface text-fg"
        }`}
      >
        <div>
          <p className="font-semibold">{copy.title}</p>
          <p className="mt-1 leading-6">{copy.body}</p>
          {status === "signed_out" && (
            <Link
              href="/login"
              className="mt-2 inline-block font-medium underline underline-offset-2"
            >
              Log in
            </Link>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex min-h-11 shrink-0 items-center self-start rounded-md px-2 py-1 font-medium underline sm:min-h-0 underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
