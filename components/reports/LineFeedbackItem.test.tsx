import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LineFeedbackItem } from "@/components/reports/LineFeedbackItem";
import { sampleCritique } from "@/tests/fixtures/resumes/critiqueView";

/**
 * Static-render checks of one line-feedback item (§13.20.6 content item 4,
 * §13.13.2 quote display). The copy button's click isn't simulated (no DOM
 * in this Vitest setup).
 */
const items = sampleCritique().line_feedback;

describe("LineFeedbackItem", () => {
  it("shows the original line exactly as received, including m² / ™ / ½ / full-width digits", () => {
    for (const item of items) {
      const html = renderToStaticMarkup(<LineFeedbackItem item={item} />);
      expect(html).toMatch(/<blockquote[^>]*>([^<]*)<\/blockquote>/);
      const quoted = html.match(/<blockquote[^>]*>([^<]*)<\/blockquote>/)?.[1];
      expect(quoted).toBe(item.original_text.replace(/&/g, "&amp;"));
    }
    const html = renderToStaticMarkup(<LineFeedbackItem item={items[0]} />);
    expect(html).toContain("40,000 m²");
    expect(renderToStaticMarkup(<LineFeedbackItem item={items[2]} />)).toContain("½-scale");
    expect(renderToStaticMarkup(<LineFeedbackItem item={items[2]} />)).toContain("SolidWorks™");
    expect(renderToStaticMarkup(<LineFeedbackItem item={items[4]} />)).toContain("３５");
  });

  it("orders original → issues → feedback → rewrite", () => {
    const html = renderToStaticMarkup(<LineFeedbackItem item={items[0]} />);
    const original = html.indexOf("<blockquote");
    const issues = html.indexOf("Weak verb");
    const feedback = html.indexOf("hides your role");
    const rewrite = html.indexOf("Suggested rewrite");
    expect(original).toBeGreaterThan(-1);
    expect(original).toBeLessThan(issues);
    expect(issues).toBeLessThan(feedback);
    expect(feedback).toBeLessThan(rewrite);
  });

  it("labels issue chips in plain language", () => {
    const html = renderToStaticMarkup(<LineFeedbackItem item={items[0]} />);
    expect(html).toContain('aria-label="Issues"');
    expect(html).toContain("Weak verb");
    expect(html).toContain("No measurable result");
  });

  it("marks [placeholders] and shows 'Needs your numbers' when needs_user_input", () => {
    const html = renderToStaticMarkup(<LineFeedbackItem item={items[0]} />);
    expect(html.match(/<mark[^>]*>\[N\]<\/mark>/)).toBeTruthy();
    expect(html.match(/<mark[^>]*>\[X%\]<\/mark>/)).toBeTruthy();
    expect(html).toContain("Needs your numbers");
    expect(html).toContain("Replace the [bracketed] parts with your real figures");
  });

  it("has no 'Needs your numbers' tag or marks when the rewrite is complete", () => {
    const html = renderToStaticMarkup(<LineFeedbackItem item={items[1]} />);
    expect(html).not.toContain("Needs your numbers");
    expect(html).not.toContain("<mark");
    expect(html).toContain(items[1].suggested_rewrite);
  });

  it("has a labelled copy button and a polite status region", () => {
    const html = renderToStaticMarkup(<LineFeedbackItem item={items[0]} />);
    expect(html).toMatch(/<button type="button" aria-describedby="lf_0-rewrite-label"[^>]*>[\s\S]*Copy<\/button>/);
    expect(html).toContain('id="lf_0-rewrite-label"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("escapes markup in model and resume text", () => {
    const html = renderToStaticMarkup(
      <LineFeedbackItem
        item={{
          ...items[0],
          original_text: "<script>alert(1)</script>",
          feedback: "<b>bold</b>",
          suggested_rewrite: "<img src=x> [N]",
        }}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>bold");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
  });
});
