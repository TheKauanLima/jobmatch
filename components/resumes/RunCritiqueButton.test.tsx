import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { RunCritiqueButton, RunCritiqueButtonView } from "@/components/resumes/RunCritiqueButton";
import { CRITIQUE_COPY } from "@/lib/client/critique";

/**
 * Static-render checks of the critique trigger's states (§13.20.6). The
 * request/response mapping is tested in lib/client/critique.test.ts; the
 * project's Vitest setup has no DOM, so clicks aren't simulated.
 */
const noop = () => {};

function render(props: Partial<Parameters<typeof RunCritiqueButtonView>[0]> = {}) {
  return renderToStaticMarkup(
    <RunCritiqueButtonView
      label={CRITIQUE_COPY.runLabel}
      pending={false}
      elapsedSeconds={null}
      error={null}
      onRun={noop}
      onRefresh={noop}
      {...props}
    />,
  );
}

describe("RunCritiqueButton", () => {
  it("initially renders an enabled 'Run critique' button and an empty live region", () => {
    const html = renderToStaticMarkup(<RunCritiqueButton resumeId="r1" />);
    const button = html.match(/<button[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(button).toContain("Run critique");
    expect(button).not.toContain('disabled=""');
    expect(html).toMatch(/<div aria-live="polite" class="sr-only"><\/div>/);
    expect(html).not.toContain('role="alert"');
  });

  it("accepts a custom label (stale re-run)", () => {
    const html = renderToStaticMarkup(
      <RunCritiqueButton resumeId="r1" label="Run updated critique" variant="secondary" />,
    );
    expect(html).toContain("Run updated critique");
  });
});

describe("RunCritiqueButtonView states", () => {
  it("pending: disabled, 'Reviewing…', the wait message in a polite live region, elapsed time", () => {
    const html = render({ pending: true, elapsedSeconds: 42 });
    const button = html.match(/<button[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(button).toContain('disabled=""');
    expect(button).toContain("Reviewing…");
    expect(html).toMatch(
      /<div aria-live="polite"[^>]*><p>Reviewing your resume\. This usually takes under a minute; keep this tab open.<\/p><\/div>/,
    );
    expect(html).toContain("Elapsed 0:42");
  });

  it("pending while refreshing: still disabled, no elapsed timer", () => {
    const html = render({ pending: true, elapsedSeconds: null });
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Elapsed");
  });

  it("error: a focusable role=alert with the message, button re-enabled", () => {
    const html = render({
      error: { message: CRITIQUE_COPY.systemError, showLogin: false, showRefresh: false },
    });
    expect(html).toMatch(/<div role="alert" tabindex="-1"[^>]*><p>Something went wrong on our side/);
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("Refresh page");
    expect(html).not.toContain("Log in again");
  });

  it("uncertain error offers a refresh; unauthorized offers a login link", () => {
    expect(
      render({ error: { message: CRITIQUE_COPY.uncertain, showLogin: false, showRefresh: true } }),
    ).toContain("Refresh page");
    const login = render({
      error: { message: CRITIQUE_COPY.unauthorized, showLogin: true, showRefresh: false },
    });
    expect(login).toMatch(/<a [^>]*href="\/login"[^>]*>Log in again<\/a>/);
  });

  it("uses §6 tokens only", () => {
    const html =
      render({ pending: true, elapsedSeconds: 3 }) +
      render({ error: { message: "x", showLogin: true, showRefresh: true } });
    expect(html).not.toMatch(
      /\b(?:bg|text|border|outline|ring)-(?:zinc|red|amber|emerald|gray|slate|white|black)\b/,
    );
  });
});
