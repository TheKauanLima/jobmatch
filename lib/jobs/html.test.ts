import { describe, expect, it } from "vitest";

import { decodeHtmlEntities, stripHtml } from "@/lib/jobs/html";

describe("stripHtml (moved unchanged from lib/jobs/themuse.ts)", () => {
  it("removes tags and preserves paragraph breaks", () => {
    expect(stripHtml("<p>Hello</p><p>World</p>")).toBe("Hello\nWorld");
  });

  it("converts <br> to a newline", () => {
    expect(stripHtml("Line one<br>Line two")).toBe("Line one\nLine two");
  });

  it("converts list items to '- ' bullet lines", () => {
    expect(stripHtml("<ul><li>One</li><li>Two</li></ul>")).toBe("- One\n- Two");
  });

  it("decodes common HTML entities", () => {
    expect(stripHtml("Ben &amp; Jerry&#39;s &lt;3 &quot;ice cream&quot;")).toBe(`Ben & Jerry's <3 "ice cream"`);
  });

  it("collapses 3+ blank lines to 2", () => {
    expect(stripHtml("<p>A</p><p></p><p></p><p>B</p>")).toBe("A\n\nB");
  });

  it("trims leading/trailing whitespace", () => {
    expect(stripHtml("  <p>  padded  </p>  ")).toBe("padded");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes decimal and hex numeric entities", () => {
    expect(decodeHtmlEntities("it&#39;s &#x27;ok&#X27; &#8217;")).toBe("it's 'ok' ’");
  });

  it("decodes common named entities case-insensitively", () => {
    expect(decodeHtmlEntities("&lt;p&gt;Tom &amp; Jerry &mdash; &NBSP;&hellip;&lt;/p&gt;")).toBe(
      "<p>Tom & Jerry —  …</p>",
    );
  });

  it("decodes one level only (no double-decoding)", () => {
    expect(decodeHtmlEntities("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });

  it("leaves unknown names and invalid code points as written", () => {
    expect(decodeHtmlEntities("&bogus; &#0; &#xD800; &#x110000; &#99999999;")).toBe(
      "&bogus; &#0; &#xD800; &#x110000; &#99999999;",
    );
  });

  it("composes with stripHtml for entity-escaped HTML (Greenhouse content)", () => {
    expect(stripHtml(decodeHtmlEntities("&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;&lt;ul&gt;&lt;li&gt;APIs&lt;/li&gt;&lt;/ul&gt;"))).toBe(
      // `</p>` and `<li>` each add a line break (v1 behaviour, kept unchanged).
      "Build & ship\n\n- APIs",
    );
  });
});
