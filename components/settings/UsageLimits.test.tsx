import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UsageLimitsView } from "@/components/settings/UsageLimits";
import { formatLocalDateTime } from "@/lib/client/formatDateTime";
import type { UsageLimitsState } from "@/lib/client/usageLimits";

/**
 * Static-render tests of each panel state. The project's Vitest setup runs
 * in a node environment (no jsdom/Testing Library), so interaction is
 * covered at the helper level (lib/client/usageLimits.test.ts) and the
 * markup per state is asserted here.
 */
function render(state: UsageLimitsState) {
  return renderToStaticMarkup(
    <UsageLimitsView state={state} onRetry={() => {}} />,
  );
}

const RESET = "2026-11-13T00:00:00.000Z";

describe("UsageLimitsView", () => {
  it("loading: busy skeleton with a screen-reader status", () => {
    const html = render({ status: "loading" });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading your usage limits");
  });

  it("error: an alert and a retry button", () => {
    const html = render({ status: "error" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("couldn&#x27;t load your usage limits");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Try again<\/button>/);
  });

  it("unauthorized: asks the user to log in again", () => {
    const html = render({ status: "unauthorized" });
    expect(html).toContain("Your session has ended");
    expect(html).toContain('href="/login"');
  });

  it("empty: explains no limits apply", () => {
    const html = render({ status: "loaded", limits: [] });
    expect(html).toContain("No daily limits apply");
    expect(html).not.toContain("<ul");
  });

  it("loaded: labels, usage and one shared reset time", () => {
    const html = render({
      status: "loaded",
      limits: [
        { kind: "resume_report", daily_limit: 5, used_today: 2, resets_at: RESET },
        { kind: "account_reauth", daily_limit: 10, used_today: 10, resets_at: RESET },
      ],
    });
    expect(html).toContain("Resume reports");
    expect(html).toContain("2 of 5 used today");
    expect(html).toContain("Password confirmations");
    expect(html).toContain("10 of 10 used today");
    expect(html.match(/Limit reached/g)).toHaveLength(1);
    expect(html).toContain(`All limits reset at ${formatLocalDateTime(RESET)}.`);
    expect(html).not.toContain("resume_report");
    expect(html).not.toContain("Resets at");
  });

  it("loaded: per-row reset times when they differ", () => {
    const other = "2026-11-14T00:00:00.000Z";
    const html = render({
      status: "loaded",
      limits: [
        { kind: "fit_check", daily_limit: 20, used_today: 0, resets_at: RESET },
        { kind: "url_import", daily_limit: 20, used_today: 3, resets_at: other },
      ],
    });
    expect(html).not.toContain("All limits reset");
    expect(html).toContain(`Resets at ${formatLocalDateTime(RESET)}.`);
    expect(html).toContain(`Resets at ${formatLocalDateTime(other)}.`);
  });

  it("loaded: a zero limit or over-limit usage renders a full bar, never NaN", () => {
    const html = render({
      status: "loaded",
      limits: [
        { kind: "fit_check", daily_limit: 0, used_today: 0, resets_at: RESET },
        { kind: "url_import", daily_limit: 2, used_today: 5, resets_at: RESET },
      ],
    });
    expect(html).not.toContain("NaN");
    expect(html.match(/width:100%/g)).toHaveLength(2);
  });

  it("uses §6 design tokens only (no raw palette classes)", () => {
    const html = [
      render({ status: "loading" }),
      render({ status: "error" }),
      render({ status: "unauthorized" }),
      render({
        status: "loaded",
        limits: [
          { kind: "fit_check", daily_limit: 1, used_today: 1, resets_at: RESET },
        ],
      }),
    ].join("");
    expect(html).not.toMatch(
      /\b(?:bg|text|border|outline|ring)-(?:zinc|red|amber|emerald|gray|slate|white|black)\b/,
    );
  });
});
