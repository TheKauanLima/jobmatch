import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));

import { DeleteAccountForm } from "@/components/settings/DeleteAccountForm";

/**
 * Static-render checks of the form's copy and accessibility wiring. The
 * response mapping it relies on is tested in
 * lib/client/accountDeletion.test.ts (the project's Vitest setup has no DOM
 * environment, so submit interactions aren't simulated here).
 */
const html = renderToStaticMarkup(<DeleteAccountForm />);

describe("DeleteAccountForm (initial render)", () => {
  it("states what is deleted and that shared listings stay, unlinked", () => {
    for (const phrase of [
      "permanent",
      "resumes",
      "analysis",
      "match",
      "private job listings",
      "private data",
      "your account",
      "Job listings you shared with everyone stay available",
      "no longer be linked to you",
    ]) {
      expect(html).toContain(phrase);
    }
  });

  it("has labelled DELETE and password inputs", () => {
    expect(html).toMatch(
      /<label for="delete-account-confirm"[^>]*>Type DELETE to confirm<\/label>/,
    );
    expect(html).toMatch(/<input id="delete-account-confirm"[^>]*type="text"/);
    expect(html).toMatch(
      /<label for="delete-account-password"[^>]*>Your password<\/label>/,
    );
    expect(html).toMatch(
      /<input id="delete-account-password"[^>]*type="password"[^>]*autoComplete="current-password"/,
    );
  });

  it("starts with no error state and an enabled submit button", () => {
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain('role="alert"');
    const button = html.match(/<button type="submit"[^>]*>([^<]*)<\/button>/);
    expect(button?.[1]).toBe("Permanently delete my account");
    expect(button?.[0]).not.toContain('disabled=""');
  });

  it("uses §6 design tokens only (no raw palette classes)", () => {
    expect(html).not.toMatch(
      /\b(?:bg|text|border|outline|ring)-(?:zinc|red|amber|emerald|gray|slate|white|black)\b/,
    );
  });
});
