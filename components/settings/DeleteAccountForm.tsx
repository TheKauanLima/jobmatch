"use client";

import { FormEvent, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/Input";
import {
  outcomeToFormResult,
  requestAccountDeletion,
  validateDeleteAccountInput,
  type DeleteAccountErrorTarget,
} from "@/lib/client/accountDeletion";
import {
  ACCOUNT_DELETE_CONFIRMATION,
  ACCOUNT_DELETE_PASSWORD_MAX_LENGTH,
} from "@/lib/validation/schemas";

const CONFIRM_ID = "delete-account-confirm";
const PASSWORD_ID = "delete-account-password";
const FORM_ERROR_ID = "delete-account-error";

/** Upper bound on the best-effort local sign-out before navigating away. */
const LOCAL_SIGN_OUT_TIMEOUT_MS = 2000;

interface FormError {
  target: DeleteAccountErrorTarget;
  message: string;
}

/**
 * Best-effort removal of any auth cookies the server couldn't clear (e.g.
 * the `204` and its Set-Cookie headers were lost and this is the `401`
 * replay). Bounded so a hung request can't keep the user on the page.
 */
async function clearLocalSession() {
  try {
    await Promise.race([
      createClient().auth.signOut({ scope: "local" }),
      new Promise((resolve) => setTimeout(resolve, LOCAL_SIGN_OUT_TIMEOUT_MS)),
    ]);
  } catch {
    // Ignore: the server already cleared the session or it no longer exists.
  }
}

/**
 * Self-serve account deletion (docs/ARCHITECTURE.md §13.13.7, M1.4b).
 *
 * Requires typing DELETE plus the account password. Responses are mapped by
 * `lib/client/accountDeletion.ts`; `204` and `401` both leave the page with
 * a full navigation to `/` (so no in-memory router cache of private pages
 * survives), and every other outcome shows inline. Field errors move focus
 * to their field (which is described by the message); form-level errors
 * move focus to the message itself.
 *
 * The password lives only in component state and the request body. It is
 * never logged, and it is cleared after a wrong-password response and
 * before navigating away.
 */
export function DeleteAccountForm() {
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<FormError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // State updates are async, so a fast double click could fire twice before
  // `disabled` renders. The ref closes that window synchronously.
  const inFlight = useRef(false);

  const confirmRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);

  function showError(next: FormError) {
    setError(next);
    // Focus after the error renders so the field's aria-describedby (or the
    // alert itself) exists when assistive tech reads the focused element.
    requestAnimationFrame(() => {
      const target =
        next.target === "confirm"
          ? confirmRef.current
          : next.target === "password"
            ? passwordRef.current
            : formErrorRef.current;
      target?.focus();
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    const invalid = validateDeleteAccountInput({ confirm, password });
    if (invalid) {
      showError(invalid);
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    setError(null);

    const result = outcomeToFormResult(await requestAccountDeletion(password));

    if (result.type === "navigate") {
      setPassword("");
      await clearLocalSession();
      // Keep the button disabled: the page is being replaced.
      window.location.replace(result.url);
      return;
    }

    if (result.target === "password") setPassword("");
    inFlight.current = false;
    setSubmitting(false);
    showError({ target: result.target, message: result.message });
  }

  const confirmError = error?.target === "confirm" ? error.message : null;
  const passwordError = error?.target === "password" ? error.message : null;
  const formError = error?.target === "form" ? error.message : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 text-sm leading-6 text-fg-muted">
        <p>
          Deleting your account is permanent and can&apos;t be undone. We
          will delete:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>your uploaded resumes and their files;</li>
          <li>every resume analysis and report;</li>
          <li>your match and fit-check results;</li>
          <li>any private job listings you saved, and your other private data;</li>
          <li>your account and sign-in details.</li>
        </ul>
        <p>
          Job listings you shared with everyone stay available to other
          students, but they will no longer be linked to you.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        noValidate
        aria-label="Delete account"
        className="flex flex-col gap-5"
      >
        <div className="flex flex-col gap-1.5">
          <Input
            ref={confirmRef}
            id={CONFIRM_ID}
            label={`Type ${ACCOUNT_DELETE_CONFIRMATION} to confirm`}
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={submitting}
            aria-invalid={confirmError ? true : undefined}
            aria-describedby={confirmError ? `${CONFIRM_ID}-error` : undefined}
          />
          {confirmError && (
            <p id={`${CONFIRM_ID}-error`} className="text-sm text-danger-fg">
              {confirmError}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Input
            ref={passwordRef}
            id={PASSWORD_ID}
            label="Your password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={ACCOUNT_DELETE_PASSWORD_MAX_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? `${PASSWORD_ID}-error` : undefined}
          />
          {passwordError && (
            <p id={`${PASSWORD_ID}-error`} className="text-sm text-danger-fg">
              {passwordError}
            </p>
          )}
        </div>

        {formError && (
          <p
            ref={formErrorRef}
            id={FORM_ERROR_ID}
            role="alert"
            tabIndex={-1}
            className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger-fg"
          >
            {formError}
          </p>
        )}

        <div>
          <button
            type="submit"
            disabled={submitting}
            aria-describedby={formError ? FORM_ERROR_ID : undefined}
            className="inline-flex items-center justify-center rounded-md border border-danger-border bg-surface px-4 py-2 text-sm font-medium text-danger-fg shadow-sm transition-colors hover:bg-danger-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger-fg disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Deleting your account…" : "Permanently delete my account"}
          </button>
        </div>
      </form>
    </div>
  );
}
