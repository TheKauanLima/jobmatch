import { describe, expect, it } from "vitest";

import { ClaudeInvalidOutputError } from "@/lib/claude/errors";
import { escapeUntrusted } from "@/lib/claude/promptEscaping";
import {
  assertHandlesExact,
  assertIntInRange,
  assertNonEmptyString,
  cleanStringList,
  createQuoteMatcher,
  fabricatedNumbers,
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
