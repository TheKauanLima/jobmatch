import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CritiqueSection } from "@/components/reports/CritiqueSection";
import { CritiquePriorities } from "@/components/reports/CritiquePriorities";
import { DimensionScoreCard } from "@/components/reports/DimensionScoreCard";
import { LineFeedbackList } from "@/components/reports/LineFeedbackList";
import { CRITIQUE_COPY } from "@/lib/client/critique";
import { sampleCritique } from "@/tests/fixtures/resumes/critiqueView";
import type { LineFeedback } from "@/types/domain";

/**
 * Static-render checks of the critique UI (docs/ARCHITECTURE.md §13.20.6;
 * ROADMAP V1.2 acceptance). The project's Vitest setup has no DOM, so the
 * "Show all" toggle and copy button aren't clicked here; their pure inputs
 * are tested in lib/client/critique.test.ts.
 */

const RAW_PALETTE =
  /\b(?:bg|text|border|outline|ring|stroke|fill)-(?:zinc|red|amber|emerald|gray|slate|neutral-\d|white|black|blue|green|yellow)\b/;

/** Visible text only, tags stripped and entities decoded, for order checks. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

describe("CritiqueSection (populated)", () => {
  const critique = sampleCritique();
  const html = renderToStaticMarkup(<CritiqueSection critique={critique} />);
  const text = textOf(html);

  it("follows the §13.20.6 content order", () => {
    const markers = [
      "66", // overall score
      critique.summary,
      critique.student_context.note,
      "Top 3 priorities",
      "Scores by area",
      "Line-by-line feedback",
      "ATS issues",
      "Missing sections",
      CRITIQUE_COPY.footer,
    ];
    let last = -1;
    for (const marker of markers) {
      const at = text.indexOf(marker, last + 1);
      expect(at, marker).toBeGreaterThan(last);
      last = at;
    }
  });

  it("shows the overall score as text with its band label", () => {
    expect(text).toMatch(/66 \/100/);
    expect(text).toContain("overall, Needs polish");
    expect(text).toContain("Late-stage student");
  });

  it("renders all 5 dimensions in the fixed order with score, rationale and fix", () => {
    const order = [
      "Impact &amp; results",
      "Clarity",
      "Relevance",
      "Structure &amp; formatting",
      "ATS readability",
    ];
    const headings = [...html.matchAll(/<h4[^>]*>([^<]+)<\/h4>/g)].map((m) => m[1]);
    expect(headings.slice(0, 5)).toEqual(order);
    for (const dimension of critique.dimensions) {
      expect(text).toContain(dimension.rationale);
      expect(text).toContain(`Fix: ${dimension.top_fix}`);
    }
    expect(text).toContain("48 /100");
    expect(html).toContain('aria-label="Impact &amp; results: 48 out of 100, Needs work"');
  });

  it("numbers the three priorities, lowest score first", () => {
    const list = html.match(/<ol[\s\S]*?<\/ol>/)?.[0] ?? "";
    const items = [...list.matchAll(/<li/g)];
    expect(items).toHaveLength(3);
    const listText = textOf(list);
    expect(listText.indexOf("Priority 1")).toBeLessThan(listText.indexOf("Priority 2"));
    expect(listText).toContain("Priority 1: Add a measurable result");
    expect(listText).toContain("Impact & results · 48/100");
  });

  it("shows the first 6 line items, then a Show all toggle", () => {
    expect(html.match(/Your line/g)).toHaveLength(6);
    expect(html).toContain("Show all 7 suggestions");
    expect(html).toContain('aria-expanded="false"');
    expect(text).not.toContain(critique.line_feedback[6].original_text);
  });

  it("lists ATS issues with fixes and missing sections", () => {
    expect(text).toContain("Contact details sit in a header text box.");
    expect(text).toContain("Fix: Move your email and phone into the main body.");
    expect(text).toContain("Relevant coursework");
    expect(text).toContain("Certifications");
  });

  it("shows the UTC date in the footer", () => {
    expect(html).toMatch(/<time dateTime="2026-11-17T15:04:05.000Z">Nov 17, 2026<\/time>/);
  });

  it("does not show section_feedback in V1 or the stale note when current", () => {
    expect(text).not.toContain("Lead with results.");
    expect(text).not.toContain("An updated critique is available");
  });

  it("uses §6 tokens only and never injects HTML", () => {
    expect(html).not.toMatch(RAW_PALETTE);
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("CritiqueSection edge cases", () => {
  it("escapes model text instead of rendering it as markup", () => {
    const html = renderToStaticMarkup(
      <CritiqueSection
        critique={sampleCritique({
          summary: '<img src=x onerror="alert(1)"> summary',
          missing_sections: ["<script>alert(1)</script>"],
        })}
      />,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows the stale note with the supplied action when is_current is false", () => {
    const html = renderToStaticMarkup(
      <CritiqueSection
        critique={sampleCritique({ is_current: false })}
        staleAction={<button type="button">Run updated critique</button>}
      />,
    );
    expect(html).toContain("An updated critique is available");
    expect(html).toContain("Run updated critique");
  });

  it("shows empty copy for no line feedback, ATS issues or missing sections", () => {
    const html = renderToStaticMarkup(
      <CritiqueSection
        critique={sampleCritique({ line_feedback: [], ats_issues: [], missing_sections: [] })}
      />,
    );
    expect(html).toContain("No line-level changes suggested");
    expect(html).toContain("No ATS issues found.");
    expect(html).toContain("No missing sections.");
    expect(html).not.toContain("Show all");
  });

  it("uses the band for the overall score at the boundaries", () => {
    expect(renderToStaticMarkup(<CritiqueSection critique={sampleCritique({ overall_score: 75 })} />)).toContain(
      "overall, Strong",
    );
    expect(renderToStaticMarkup(<CritiqueSection critique={sampleCritique({ overall_score: 49 })} />)).toContain(
      "overall, Needs work",
    );
  });
});

describe("LineFeedbackList", () => {
  it("shows no toggle at exactly 6 items", () => {
    const items = sampleCritique().line_feedback.slice(0, 6);
    const html = renderToStaticMarkup(<LineFeedbackList items={items} />);
    expect(html.match(/Your line/g)).toHaveLength(6);
    expect(html).not.toContain("Show all");
  });

  it("groups under section headings with counts", () => {
    const html = renderToStaticMarkup(<LineFeedbackList items={sampleCritique().line_feedback} />);
    expect(textOf(html)).toMatch(/Experience \(3\)/);
    expect(textOf(html)).toMatch(/Projects \(2\)/);
  });

  it("controls the list it toggles", () => {
    const items: LineFeedback[] = sampleCritique().line_feedback;
    const html = renderToStaticMarkup(<LineFeedbackList items={items} />);
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
  });
});

describe("DimensionScoreCard", () => {
  it("never relies on color alone: score and band are text", () => {
    const html = renderToStaticMarkup(
      <DimensionScoreCard
        dimension={{ dimension: "clarity", score: 82, rationale: "Clear.", top_fix: "Tighten." }}
      />,
    );
    expect(textOf(html)).toContain("82 /100");
    expect(textOf(html)).toContain("Strong");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("width:82%");
  });

  it("clamps the bar but shows the real score", () => {
    const html = renderToStaticMarkup(
      <DimensionScoreCard
        dimension={{ dimension: "impact", score: 120, rationale: "r", top_fix: "f" }}
      />,
    );
    expect(html).toContain("width:100%");
    expect(textOf(html)).toContain("120 /100");
  });
});

describe("CritiquePriorities", () => {
  it("renders nothing when there are no priorities", () => {
    expect(renderToStaticMarkup(<CritiquePriorities priorities={[]} />)).toBe("");
  });
});
