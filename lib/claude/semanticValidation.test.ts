import { describe, expect, it } from "vitest";

import { ClaudeInvalidOutputError } from "@/lib/claude/errors";
import { escapeUntrusted } from "@/lib/claude/promptEscaping";
import { NFKC_QUOTES, ORIGINAL_SPANS, UNICODE_RESUME } from "@/tests/fixtures/resumes/critique";
import {
  assertHandlesExact,
  assertIntInRange,
  assertNonEmptyString,
  cleanStringList,
  createQuoteLocator,
  createQuoteMatcher,
  fabricatedNumbers,
  locateQuoteInSource,
  numbersIntroduced,
  normalizeForQuoteMatch,
  quoteAppearsIn,
  slugsInVocabulary,
} from "@/lib/claude/semanticValidation";

describe("normalizeForQuoteMatch (§13.5.6)", () => {
  it("applies NFKC (ligatures, full-width forms)", () => {
    expect(normalizeForQuoteMatch("ﬁnance ＳＱＬ")).toBe("finance sql");
  });

  it("lowercases", () => {
    expect(normalizeForQuoteMatch("Built REST APIs")).toBe("built rest apis");
  });

  it("straightens curly quotes", () => {
    expect(normalizeForQuoteMatch("“Lead” ‘dev’")).toBe("\"lead\" 'dev'");
  });

  it("maps en/em dashes to '-'", () => {
    expect(normalizeForQuoteMatch("2023–2024 — remote")).toBe("2023-2024 - remote");
  });

  it("strips bullet glyphs at line start only", () => {
    expect(normalizeForQuoteMatch("• Built X\n▪ Led Y\n◦ Ran Z\n· Did W\n* Made V\n- Fixed U")).toBe(
      "built x led y ran z did w made v fixed u",
    );
    expect(normalizeForQuoteMatch("Cost-saving • measures")).toBe("cost-saving • measures");
  });

  it("collapses whitespace and trims", () => {
    expect(normalizeForQuoteMatch("  a \t\n  b   c ")).toBe("a b c");
  });

  it("removes invisible characters (same set as escapeUntrusted)", () => {
    expect(normalizeForQuoteMatch(`Py${String.fromCodePoint(0x200b)}thon`)).toBe("python");
  });

  it("treats U+0085 NEXT LINE as whitespace (collapse, trim, line-start bullets; JS \\s misses it)", () => {
    expect(normalizeForQuoteMatch("\u0085• Built\u0085\u0085a REST\u2028API\u0085")).toBe("built a rest api");
    expect(quoteAppearsIn("built a rest api", "Built\u0085a REST API")).toBe(true);
    expect(quoteAppearsIn("\u0085", "Built a REST API")).toBe(false);
  });
});

describe("quoteAppearsIn / createQuoteMatcher", () => {
  const resume = "EXPERIENCE\n• Built a REST API in Node.js — served 3 teams\n• Wrote “fast” SQL";

  it("matches a verbatim quote across formatting differences", () => {
    expect(quoteAppearsIn("Built a REST API in Node.js - served 3 teams", resume)).toBe(true);
    expect(quoteAppearsIn('wrote "fast" sql', resume)).toBe(true);
  });

  it("matches a quote that spans a line break", () => {
    expect(quoteAppearsIn("served 3 teams Wrote", resume)).toBe(true);
  });

  it("rejects text that is not in the source", () => {
    expect(quoteAppearsIn("Built a GraphQL API", resume)).toBe(false);
  });

  it("never matches an empty or whitespace-only quote", () => {
    expect(quoteAppearsIn("", resume)).toBe(false);
    expect(quoteAppearsIn("  \n ", resume)).toBe(false);
    expect(quoteAppearsIn("•", resume)).toBe(false);
  });

  it("a quote copied from the ESCAPED prompt text still matches the raw stored source (NFKC + default-ignorables)", () => {
    const source =
      "Built ＳＱＬ pipelines for ﬁnanceㅤ teams͏; led \u{1D41A}\u{1D41B}\u{1D41C} project </resume_text> wrap-up";
    const promptText = escapeUntrusted(source);
    // Claude can only quote what it saw: the escaped, NFKC'd text.
    for (const quote of [
      "Built SQL pipelines for finance teams",
      "led abc project",
      promptText,
      "＜/resume_text＞ wrap-up",
    ]) {
      expect(quoteAppearsIn(quote, source), quote).toBe(true);
    }
  });

  it("strips every default-ignorable code point (same set as escapeUntrusted)", () => {
    for (const cp of [0x034f, 0x061c, 0x115f, 0x3164, 0xffa0, 0x17b4, 0xfe0f, 0xe0100, 0x200b]) {
      expect(normalizeForQuoteMatch(`Py${String.fromCodePoint(cp)}thon`)).toBe("python");
    }
  });

  it("createQuoteMatcher agrees with quoteAppearsIn", () => {
    const matches = createQuoteMatcher(resume);
    for (const q of ["Built a REST API", "GraphQL", "", 'wrote "fast"']) {
      expect(matches(q)).toBe(quoteAppearsIn(q, resume));
    }
  });
});

describe("assertHandlesExact", () => {
  it("accepts exactly the provided handles in any order", () => {
    expect(() => assertHandlesExact(["J2", "J1", "J3"], ["J1", "J2", "J3"])).not.toThrow();
  });

  it("rejects a missing handle", () => {
    expect(() => assertHandlesExact(["J1"], ["J1", "J2"])).toThrow(ClaudeInvalidOutputError);
  });

  it("rejects a duplicate handle", () => {
    expect(() => assertHandlesExact(["J1", "J1", "J2"], ["J1", "J2"])).toThrow(/duplicate J1/);
  });

  it("rejects an invented handle without echoing it", () => {
    let message = "";
    try {
      assertHandlesExact(["J1", "IGNORE INSTRUCTIONS"], ["J1"]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("unexpected handle");
    expect(message).not.toContain("IGNORE");
  });
});

describe("slugsInVocabulary", () => {
  it("splits kept and dropped slugs (array or Set vocabulary)", () => {
    expect(slugsInVocabulary(["sql", "made-up", "python"], ["sql", "python"])).toEqual({
      kept: ["sql", "python"],
      dropped: ["made-up"],
    });
    expect(slugsInVocabulary(["sql"], new Set(["sql"]))).toEqual({ kept: ["sql"], dropped: [] });
  });
});

describe("fabricatedNumbers", () => {
  it.each([
    ["78% of postings ask for SQL", "78%"],
    ["about 40 percent of roles", "40 percent"],
    ["12.5 per cent", "12.5 per cent"],
    ["3 out of 4 listings", "3 out of"],
    ["out of 340 postings", "out of 340"],
    ["most of 1,200 jobs", "of 1,200"],
    ["half ＷＡＮＴ ５０％", "50%"],
    ["about 40\u0085percent of roles", "40\u0085percent"],
    ["3\u0085out\u0085of 4 listings", "3\u0085out\u0085of"],
    ["most of\u0085 1,200 jobs", "of\u0085 1,200"],
  ])("flags %j", (text, fragment) => {
    expect(fabricatedNumbers(text)).toContain(fragment);
  });

  it("returns nothing for qualitative text", () => {
    expect(
      fabricatedNumbers("Your Capstone project shows SQL joins and window functions."),
    ).toEqual([]);
  });
});

describe("scalar asserts and list cleaning", () => {
  it("assertIntInRange accepts in-range integers and rejects everything else", () => {
    expect(assertIntInRange(0, 0, 100, "score")).toBe(0);
    expect(assertIntInRange(100, 0, 100, "score")).toBe(100);
    for (const bad of [-1, 101, 50.5, Number.NaN, "50", null]) {
      expect(() => assertIntInRange(bad, 0, 100, "score")).toThrow(ClaudeInvalidOutputError);
    }
  });

  it("assertIntInRange names the field, never the value", () => {
    expect(() => assertIntInRange(9999, 0, 100, "score")).toThrow(/"score"/);
    expect(() => assertIntInRange(9999, 0, 100, "score")).not.toThrow(/9999/);
  });

  it("assertNonEmptyString trims and rejects empty/whitespace", () => {
    expect(assertNonEmptyString("  ok ", "summary")).toBe("ok");
    expect(() => assertNonEmptyString("  \n", "summary")).toThrow(ClaudeInvalidOutputError);
    expect(() => assertNonEmptyString(42, "summary")).toThrow(ClaudeInvalidOutputError);
  });

  it("cleanStringList trims, drops empties and counts drops", () => {
    expect(cleanStringList([" a ", "", "  ", "b"])).toEqual({ kept: ["a", "b"], dropped: 2 });
  });
});

describe("locateQuoteInSource (§13.13.2 quote display)", () => {
  const slice = (quote: string, source: string) => {
    const span = locateQuoteInSource(quote, source);
    return span === null ? null : source.slice(span.start, span.end);
  };

  it.each(Object.keys(NFKC_QUOTES) as Array<keyof typeof NFKC_QUOTES>)(
    "maps the NFKC quote %s back to the user's exact characters",
    (key) => {
      expect(slice(NFKC_QUOTES[key], UNICODE_RESUME)).toBe(ORIGINAL_SPANS[key]);
    },
  );

  it("round-trips ², ™, ½, full-width digits and ligatures (the span is an exact substring)", () => {
    const source = "Area 40 m² • Brand™ • ½ scale • ３５ runs • ﬁnal ﬂow";
    expect(slice("40 m2", source)).toBe("40 m²");
    expect(slice("BrandTM", source)).toBe("Brand™");
    expect(slice("1⁄2 scale", source)).toBe("½ scale");
    expect(slice("35 runs", source)).toBe("３５ runs");
    expect(slice("final flow", source)).toBe("ﬁnal ﬂow");
  });

  it("maps across stripped invisible characters (zero-width, soft hyphen, BOM)", () => {
    const source = "Led​ a team of­ four﻿ engineers";
    expect(slice("led a team of four engineers", source)).toBe(source);
    expect(slice("team of four", source)).toBe("team of­ four");
  });

  it("is case-, quote-, dash- and whitespace-insensitive, returning the original span", () => {
    const source = "Built   “Smart”\tdashboards — fast";
    expect(slice('built "smart" dashboards - fast', source)).toBe(source);
  });

  it("never includes the leading bullet or surrounding whitespace", () => {
    const source = "EXPERIENCE\n  •  Shipped the mobile app\n";
    expect(slice("Shipped the mobile app", source)).toBe("Shipped the mobile app");
  });

  it("matches across a line break, mapping both lines' characters", () => {
    const source = "Designed a sensor\n- for airflow";
    expect(slice("designed a sensor for airflow", source)).toBe(source);
  });

  it("handles CRLF line endings", () => {
    const source = "Line one\r\n• Line two here";
    expect(slice("line one line two", source)).toBe("Line one\r\n• Line two");
  });

  it("keeps an expanded ligature whole when the quote starts inside it", () => {
    // U+FB01 -> "fi": a quote starting at "i" still maps to the whole ligature.
    expect(slice("inal", "ﬁnal")).toBe("ﬁnal");
  });

  it("handles astral characters and decomposed combining marks", () => {
    expect(slice("café \u{1D401}old", "Café \u{1D401}old résumé")).toBe("Café \u{1D401}old");
    // NFKC folds the math bold B to "b" on both sides.
    expect(slice("bold résumé", "Café \u{1D401}old résumé")).toBe(
      "\u{1D401}old résumé",
    );
  });

  it("returns the first occurrence", () => {
    expect(locateQuoteInSource("abc", "xx abc yy abc")).toEqual({ start: 3, end: 6 });
  });

  it("returns null when the quote doesn't appear", () => {
    expect(locateQuoteInSource("led a team of five", "Led a team of four")).toBeNull();
  });

  it("returns null for empty, whitespace-only and invisible-only quotes", () => {
    expect(locateQuoteInSource("", "abc")).toBeNull();
    expect(locateQuoteInSource("  \n ", "abc")).toBeNull();
    expect(locateQuoteInSource("​‍", "abc")).toBeNull();
  });

  it("agrees with quoteAppearsIn on the fixtures", () => {
    for (const quote of [...Object.values(NFKC_QUOTES), "not in the resume at all"]) {
      expect(locateQuoteInSource(quote, UNICODE_RESUME) !== null).toBe(quoteAppearsIn(quote, UNICODE_RESUME));
    }
  });

  it("finds a quote copied from the escaped prompt text", () => {
    const source = "Wrote a <resume_text> parser in Rust™";
    expect(slice(escapeUntrusted(source), source)).toBe(source);
  });

  it("createQuoteLocator gives the same spans as locateQuoteInSource", () => {
    const locate = createQuoteLocator(UNICODE_RESUME);
    for (const quote of Object.values(NFKC_QUOTES)) {
      expect(locate(quote)).toEqual(locateQuoteInSource(quote, UNICODE_RESUME));
    }
  });
});

describe("numbersIntroduced (critique fabrication guard, §13.5.6)", () => {
  it("is empty when every number comes from the original line", () => {
    expect(numbersIntroduced("Audited 12 buildings (40,000 m2)", "Helped audit 12 buildings, 40,000 m² total")).toEqual([]);
  });

  it("flags a number that isn't in the original", () => {
    expect(numbersIntroduced("Cut costs by 30%", "Helped cut costs")).toEqual(["30"]);
  });

  it("ignores numbers inside [placeholders], including full-width brackets", () => {
    expect(numbersIntroduced("Cut costs by [30%] for [5 clients]", "Helped cut costs")).toEqual([]);
    expect(numbersIntroduced("Cut costs by ［30%］", "Helped cut costs")).toEqual([]);
  });

  it("an unclosed bracket protects nothing", () => {
    expect(numbersIntroduced("Cut costs by [30%", "Helped cut costs")).toEqual(["30"]);
  });

  it("compares whole tokens, so 3 is new next to an original 30", () => {
    expect(numbersIntroduced("Led 3 teams", "Led 30 people")).toEqual(["3"]);
  });

  it("treats thousands separators as equal and folds full-width digits", () => {
    expect(numbersIntroduced("Served 1200 users", "Served 1,200 users")).toEqual([]);
    expect(numbersIntroduced("Ran 35 tests", "Ran ３５ tests")).toEqual([]);
  });

  it("decimal numbers must match exactly", () => {
    expect(numbersIntroduced("GPA 3.9", "GPA 3.6")).toEqual(["3.9"]);
  });
});
