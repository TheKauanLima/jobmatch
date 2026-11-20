import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SampleCritiqueShowcase } from "@/components/SampleCritiqueShowcase";
import { CritiqueSection } from "@/components/reports/CritiqueSection";
import {
  SAMPLE_CRITIQUE,
  SAMPLE_LINE_FEEDBACK_PREVIEW_COUNT,
} from "@/lib/marketing/sampleCritique";
import { CRITIQUE_DIMENSION_ORDER, deriveCritiquePriorities } from "@/types/domain";

describe("SAMPLE_CRITIQUE (landing-page showcase data)", () => {
  it("keeps the same invariants as real API data", () => {
    expect(SAMPLE_CRITIQUE.dimensions.map((d) => d.dimension)).toEqual([
      ...CRITIQUE_DIMENSION_ORDER,
    ]);
    for (const score of [
      SAMPLE_CRITIQUE.overall_score,
      ...SAMPLE_CRITIQUE.dimensions.map((d) => d.score),
    ]) {
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
    expect(SAMPLE_CRITIQUE.priorities).toEqual(
      deriveCritiquePriorities(SAMPLE_CRITIQUE.dimensions),
    );
  });

  it("has unique line ids and a placeholder rewrite inside the trimmed preview", () => {
    const ids = SAMPLE_CRITIQUE.line_feedback.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SAMPLE_CRITIQUE.line_feedback.length).toBeGreaterThan(
      SAMPLE_LINE_FEEDBACK_PREVIEW_COUNT,
    );
    const preview = SAMPLE_CRITIQUE.line_feedback.slice(0, SAMPLE_LINE_FEEDBACK_PREVIEW_COUNT);
    expect(
      preview.some((item) => item.needs_user_input && /\[[^\]]+\]/.test(item.suggested_rewrite)),
    ).toBe(true);
    // needs_user_input must mean "has a placeholder", as for real data.
    for (const item of SAMPLE_CRITIQUE.line_feedback) {
      expect(item.needs_user_input).toBe(/\[[^\]]+\]/.test(item.suggested_rewrite));
    }
  });
});

describe("SampleCritiqueShowcase", () => {
  const html = renderToStaticMarkup(<SampleCritiqueShowcase />);

  it("is labelled as a fictional sample and links to sign-up", () => {
    expect(html).toContain("See what you get");
    expect(html).toContain("Sample critique · fictional resume");
    expect(html).toContain('href="/signup"');
  });

  it("trims line feedback to the preview count and hides the generated date", () => {
    const total = SAMPLE_CRITIQUE.line_feedback.length;
    expect(html).toContain(`Showing ${SAMPLE_LINE_FEEDBACK_PREVIEW_COUNT} of ${total}`);
    const shown = SAMPLE_CRITIQUE.line_feedback.filter((item) =>
      html.includes(escapeHtml(item.original_text)),
    );
    expect(shown).toHaveLength(SAMPLE_LINE_FEEDBACK_PREVIEW_COUNT);
    expect(html).not.toMatch(/Generated /);
  });
});

describe("CritiqueSection without the showcase props", () => {
  it("still shows every line item's section and the generated date", () => {
    const html = renderToStaticMarkup(<CritiqueSection critique={SAMPLE_CRITIQUE} />);
    expect(html).toMatch(/Generated /);
    expect(html).not.toContain("Showing 3 of");
  });
});

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
