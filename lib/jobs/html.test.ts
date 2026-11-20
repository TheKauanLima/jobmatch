import { describe, expect, it } from "vitest";

import { decodeHtmlEntities, stripHtml } from "@/lib/jobs/html";

// Moved unchanged from the deleted lib/jobs/themuse.test.ts (§7.7.8).
describe("stripHtml", () => {
  it("removes tags and preserves paragraph breaks", () => {
    expect(stripHtml("<p>Hello</p><p>World</p>")).toBe("Hello\nWorld");
  });

  it("converts <br> to a newline", () => {
    expect(stripHtml("Line one<br>Line two")).toBe("Line one\nLine two");
  });

  it("converts list items to '- ' bullet lines", () => {
    expect(stripHtml("<ul><li>One</li><li>Two</li></ul>")).toBe(
      "- One\n- Two",
    );
  });

  it("decodes common HTML entities", () => {
    expect(stripHtml("Ben &amp; Jerry&#39;s &lt;3 &quot;ice cream&quot;")).toBe(
      `Ben & Jerry's <3 "ice cream"`,
    );
  });

  it("collapses 3+ blank lines to 2", () => {
    expect(stripHtml("<p>A</p><p></p><p></p><p>B</p>")).toBe("A\n\nB");
  });

  it("trims leading/trailing whitespace", () => {
    expect(stripHtml("  <p>  padded  </p>  ")).toBe("padded");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes the named entities", () => {
    expect(
      decodeHtmlEntities("&lt;p&gt; &amp; &quot;x&quot; &apos;y&apos; a&nbsp;b"),
    ).toBe(`<p> & "x" 'y' a b`);
  });

  it("decodes decimal and hex numeric references", () => {
    expect(decodeHtmlEntities("it&#39;s &#8212; &#x2014; &#X41;")).toBe(
      "it's — — A",
    );
  });

  it("decodes in a single pass (&amp;lt; becomes the text &lt;, not <)", () => {
    expect(decodeHtmlEntities("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });

  it("leaves unknown named entities and invalid code points alone", () => {
    expect(decodeHtmlEntities("&copy; &#0; &#xD800; &#99999999;")).toBe(
      "&copy; &#0; &#xD800; &#99999999;",
    );
  });

  it("leaves text without entities unchanged", () => {
    expect(decodeHtmlEntities("a & b; c")).toBe("a & b; c");
  });

  it("decode then strip turns Greenhouse's escaped markup into plain text", () => {
    const escaped =
      "&lt;div class=&quot;intro&quot;&gt;&lt;p&gt;We&amp;#39;re hiring &amp;amp; growing.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;&lt;/div&gt;";
    expect(stripHtml(decodeHtmlEntities(escaped))).toBe(
      "We're hiring & growing.\n\n- Python",
    );
  });
});
