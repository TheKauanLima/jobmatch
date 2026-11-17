import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  computeDedupeKey,
  DEDUPE_KEY_LENGTH,
  normalizeCompany,
  normalizePrimaryLocation,
  normalizeTitle,
} from "@/lib/jobs/normalize";

describe("normalizeCompany (§13.6.4)", () => {
  it.each([
    ["Acme", "acme"],
    ["ACME Inc.", "acme"],
    ["Acme, Inc.", "acme"],
    ["Acme,Inc", "acme"],
    ["Acme Co., Inc.", "acme"],
    ["Acme Corporation", "acme"],
    ["Acme Holdings LLC", "acme holdings"],
    ["Beta GmbH", "beta"],
    ["Gamma PLC", "gamma"],
    ["Delta L.L.P.", "delta"],
    ["J.P. Morgan", "jp morgan"],
    ["Macy's", "macys"],
    ["AT&T", "at t"],
    ["  Wide   Spaces  Ltd ", "wide spaces"],
    ["Ｆｕｌｌｗｉｄｔｈ Inc", "fullwidth"],
    ["Company", "company"],
    ["The Coca-Cola Company", "the coca cola"],
    ["Incorporated Widgets", "incorporated widgets"],
    ["...", ""],
  ])("%j → %j", (input, expected) => {
    expect(normalizeCompany(input)).toBe(expected);
  });
});

describe("normalizeTitle (§13.6.4)", () => {
  it.each([
    ["Software Engineer", "software engineer"],
    ["Software Engineer (Remote)", "software engineer"],
    ["Software Engineer [2027]", "software engineer"],
    ["Software Engineer - Remote", "software engineer"],
    ["Software Engineer | Hybrid", "software engineer"],
    ["Software Engineer, On-site", "software engineer"],
    ["Software Engineer – Onsite", "software engineer"],
    ["Data Analyst/Scientist: Intern", "data analyst scientist intern"],
    ["Ｄａｔａ Analyst", "data analyst"],
    ["Remote Sensing Analyst", "sensing analyst"],
    ["Front-End Developer", "front end developer"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });
});

describe("normalizePrimaryLocation (§13.6.4)", () => {
  it("is 'remote' for remote listings regardless of the location", () => {
    expect(normalizePrimaryLocation("remote", { city: "NYC", region: null, country: null })).toBe("remote");
  });

  it("is city|region|country lowercased otherwise", () => {
    expect(normalizePrimaryLocation("onsite", { city: "New York", region: "NY", country: "US" })).toBe("new york|ny|us");
    expect(normalizePrimaryLocation(null, { city: "London", region: null, country: "GB" })).toBe("london||gb");
  });

  it("is '' with no location or an all-empty one", () => {
    expect(normalizePrimaryLocation(null, null)).toBe("");
    expect(normalizePrimaryLocation("hybrid", { city: null, region: " ", country: null })).toBe("");
  });
});

describe("computeDedupeKey (§13.6.4)", () => {
  const base = {
    company: "Acme, Inc.",
    title: "Data Analyst Intern (Summer 2027)",
    remoteType: null,
    primaryLocation: { city: "New York", region: "NY", country: "US" },
  } as const;

  it("is the first 32 hex chars of sha256(company|title|location)", () => {
    const expected = createHash("sha256").update("acme|data analyst intern|new york|ny|us").digest("hex").slice(0, 32);
    expect(computeDedupeKey(base)).toBe(expected);
    expect(computeDedupeKey(base)).toHaveLength(DEDUPE_KEY_LENGTH);
  });

  it("matches across cosmetic differences between sources", () => {
    expect(
      computeDedupeKey({
        company: "ACME INC",
        title: "Data Analyst Intern - Onsite",
        remoteType: "onsite",
        primaryLocation: { city: "new york", region: "ny", country: "us" },
      }),
    ).toBe(computeDedupeKey(base));
  });

  it("differs when the company, title or location differs", () => {
    const key = computeDedupeKey(base);
    expect(computeDedupeKey({ ...base, company: "Acme Labs" })).not.toBe(key);
    expect(computeDedupeKey({ ...base, title: "Data Engineer Intern" })).not.toBe(key);
    expect(computeDedupeKey({ ...base, primaryLocation: { city: "Boston", region: "MA", country: "US" } })).not.toBe(key);
    expect(computeDedupeKey({ ...base, remoteType: "remote" })).not.toBe(key);
  });

  it("is null without a company, or when the company normalizes to nothing", () => {
    expect(computeDedupeKey({ ...base, company: null })).toBeNull();
    expect(computeDedupeKey({ ...base, company: " .,! " })).toBeNull();
  });

  it("is deterministic (property: same input → same key, always 32 lowercase hex chars)", () => {
    const companies = ["A", "Acme Inc", "Ünïcödé GmbH", "x".repeat(300)];
    const titles = ["Intern", "Senior Staff Engineer (Remote) | Platform", ""];
    for (const company of companies) {
      for (const title of titles) {
        const input = { company, title, remoteType: null, primaryLocation: null };
        const a = computeDedupeKey(input);
        expect(a).toBe(computeDedupeKey({ ...input }));
        expect(a).toMatch(/^[0-9a-f]{32}$/);
      }
    }
  });
});
