import { describe, expect, it } from "vitest";

import {
  classifyStudentLevel,
  hasNonUsSignal,
  hasUsSignal,
  isUsLocation,
} from "@/lib/jobs/studentFilter";

describe("classifyStudentLevel", () => {
  it.each([
    // Required cases (§7.7.3)
    ["Internal Tools Engineer", null],
    ["International Sales", null],
    ["Software Engineer I", "Entry Level"],
    ["Software Engineer II", null],
    ["Jr. Data Analyst", "Entry Level"],
    ["Senior Associate", null],
    // Senior terms win over student terms
    ["Internship Program Manager", null],
    ["Sr. Software Engineer", null],
    ["Staff Engineer, New Grad Hiring", null],
    ["Head of University Recruiting", null],
    ["Engineering Lead", null],
    // Internship terms
    ["Software Engineer Intern", "Internship"],
    ["Software Engineering Internship (Summer 2027)", "Internship"],
    ["Data Science Interns", "Internship"],
    ["Mechanical Engineering Co-op", "Internship"],
    ["Hardware Coop - Fall", "Internship"],
    ["Student Researcher", "Internship"],
    ["INTERN, MARKETING", "Internship"],
    // Entry-level terms
    ["Software Engineer, New Grad (2027)", "Entry Level"],
    ["New Graduate Program - Finance", "Entry Level"],
    ["Entry-Level Account Executive", "Entry Level"],
    ["Entry Level Analyst", "Entry Level"],
    ["Junior Designer", "Entry Level"],
    ["Associate Product Designer", "Entry Level"],
    ["Apprentice Electrician", "Entry Level"],
    ["Early Career Software Engineer", "Entry Level"],
    ["University Grad - Software Engineer", "Entry Level"],
    ["Campus Ambassador", "Entry Level"],
    ["Data Analyst I", "Entry Level"],
    ["Support Engineer Level 1", "Entry Level"],
    ["Trainee Pilot", "Entry Level"],
    // Neither
    ["Software Engineer", null],
    ["Account Executive", null],
    ["Data Analyst II", null],
    ["Engineer III", null],
    ["", null],
  ])("%j -> %j", (title, expected) => {
    expect(classifyStudentLevel(title)).toBe(expected);
  });
});

describe("isUsLocation", () => {
  it.each([
    // Required cases (§7.7.3)
    ["Toronto, ON", false],
    ["New York, NY; London", true],
    ["Remote", true],
    // US signals
    ["San Francisco, CA", true],
    ["San Francisco, CA • New York, NY", true],
    ["Washington, DC", true],
    ["Remote - US", true],
    ["Remote, USA", true],
    ["United States", true],
    ["U.S. Remote", true],
    ["Austin, Texas", true],
    ["New York City, New York, United States", true],
    ["Hybrid - Seattle, WA", true],
    // Empty / remote-only
    ["", true],
    ["   ", true],
    ["Anywhere", true],
    ["(Remote)", true],
    ["remote.", true],
    // Not US
    ["Vancouver, BC", false],
    ["London, United Kingdom", false],
    ["Remote - Canada", false],
    ["Paris, France", false],
    ["Mexico City, Mexico", false],
    ["Sydney, Australia", false],
    ["Hybrid", false],
  ])("%j -> %j", (text, expected) => {
    expect(isUsLocation(text)).toBe(expected);
  });

  it("treats null text like empty text (kept)", () => {
    expect(isUsLocation(null)).toBe(true);
  });

  it("lets a country code decide on its own when present", () => {
    expect(isUsLocation("London", "US")).toBe(true);
    expect(isUsLocation("New York, NY", "GB")).toBe(false);
    expect(isUsLocation(null, "us")).toBe(true);
    expect(isUsLocation("Remote", "CA")).toBe(false);
  });

  it("falls back to the text when the country code is null or blank", () => {
    expect(isUsLocation("Toronto, ON", null)).toBe(false);
    expect(isUsLocation("Boston, MA", "")).toBe(true);
  });

  it("hasUsSignal needs a positive US signal (blank/Remote-only don't count)", () => {
    expect(hasUsSignal("Los Angeles, California, United States")).toBe(true);
    expect(hasUsSignal("San Francisco, CA")).toBe(true);
    expect(hasUsSignal("Toronto, Ontario, Canada")).toBe(false);
    expect(hasUsSignal("Remote")).toBe(false);
    expect(hasUsSignal("")).toBe(false);
    expect(hasUsSignal(null)).toBe(false);
    expect(hasUsSignal(undefined)).toBe(false);
  });

  it("does not treat lowercase 'us' as a US signal", () => {
    expect(isUsLocation("Join us in Berlin")).toBe(false);
  });
});

describe("hasNonUsSignal", () => {
  it.each([
    ["Vancouver, British Columbia, Canada", true],
    ["São Paulo, São Paulo, Brazil", true],
    ["Sao Paulo", true],
    ["Toronto", true],
    ["Remote Canada", true],
    ["Remote - Canada: Select locations", true],
    ["Waterloo, ON", true],
    ["London, UK", true],
    ["Lisboa, Lisboa, Portugal", true],
    ["Bengaluru", true],
    ["Remote - EMEA", true],
    // Placeless or US-only text: no explicit non-US signal
    ["Hybrid", false],
    ["In-Office", false],
    ["Remote", false],
    ["San Francisco Bay Area", false],
    ["Los Angeles Metropolitan Area or New York City Metropolitan Area", false],
    ["Austin", false],
    ["Seattle, San Francisco", false],
    ["New Mexico", false],
    ["", false],
  ])("%j -> %j", (text, expected) => {
    expect(hasNonUsSignal(text)).toBe(expected);
  });

  it("treats null/undefined as no signal", () => {
    expect(hasNonUsSignal(null)).toBe(false);
    expect(hasNonUsSignal(undefined)).toBe(false);
  });
});

describe("classifyStudentLevel: QA probes (2026-11-20)", () => {
  it.each([
    // "intern" must not match inside other words
    ["Interim Controller", null],
    ["Internal Audit Intern", "Internship"],
    ["Internal Audit Analyst", null],
    // Intern-program management titles are not internships
    ["Intern Manager", null],
    ["Senior Intern Program Manager", null],
    ["Engineering Manager, Intern Program", null],
    ["Team Lead Intern", null],
    // Engineer I vs II/III/IV
    ["Engineer I", "Entry Level"],
    ["Software Engineer III", null],
    ["Software Engineer IV", null],
    ["Data Engineer I.", "Entry Level"],
    ["Software Engineer I/II", "Entry Level"],
    // New grad spelling variants (previously dropped)
    ["New-Grad Software Engineer", "Entry Level"],
    ["Newgrad SWE", "Entry Level"],
    ["New Grads - Software Engineering", "Entry Level"],
    ["NEW GRAD", "Entry Level"],
    ["New Graduates Program", "Entry Level"],
    // Early career variants (previously dropped)
    ["Early-Career Engineer", "Entry Level"],
    ["Early Careers Program - Sales", "Entry Level"],
    // Apprenticeship (previously dropped)
    ["Software Apprenticeship Program", "Entry Level"],
    ["Apprenticeships - IT", "Entry Level"],
    // Entry level with odd spacing (previously dropped)
    ["Entry  Level Analyst", "Entry Level"],
    // "Associate" false positives on senior legal titles (seen live: reddit)
    ["Associate General Counsel, Ads Product", null],
    ["General Counsel", null],
    // Any "counsel" title is senior (seen live: discord)
    ["Associate Commercial Counsel", null],
    ["Associate Product Counsel", null],
    // ...but "counselor" is a different word and is not matched
    ["Associate Counselor", "Entry Level"],
    // "Associate" senior variants are still dropped by the senior pattern
    ["Associate Director, Finance", null],
    ["Associate Manager", null],
    // Entry-level associate titles are still kept
    ["Customer Experience Associate", "Entry Level"],
    // Look-alikes that must stay dropped
    ["Newsroom Graduate", null],
    ["Careers Site Engineer", null],
  ])("%j -> %j", (title, expected) => {
    expect(classifyStudentLevel(title)).toBe(expected);
  });
});

describe("isUsLocation: ambiguous two-letter codes (CA = Canada vs California, etc.)", () => {
  it.each([
    // The live bug: Greenhouse "City, Region, CC" with CC = CA (Canada)
    ["Toronto, ON, CA", false],
    ["Toronto, Ontario, CA", false],
    ["Vancouver, BC, CA", false],
    ["Montreal, QC, CA", false],
    ["Toronto, CA", false],
    ["Remote - Canada, CA", false],
    // California must stay US
    ["San Francisco, CA", true],
    ["San Francisco, CA, US", true],
    ["Los Angeles, CA", true],
    ["Remote, CA", true],
    ["Remote, CA, US", true],
    ["San Francisco, CA, US; Remote, CA, US", true],
    ["Foster City, CA, San Diego, CA, Seattle, WA", true],
    // US towns sharing a name with a non-US city
    ["Dublin, CA", true],
    ["London, KY", true],
    ["Paris, TN", true],
    ["Vancouver, WA", true],
    // IN: India vs Indiana
    ["Mumbai, IN", false],
    ["Bangalore, KA, IN", false],
    ["Indianapolis, IN", true],
    // DE: Germany vs Delaware
    ["Munich, DE", false],
    ["Berlin, BE, DE", false],
    ["Wilmington, DE", true],
    // GA / Georgia: the country vs the state
    ["Tbilisi, GA", false],
    ["Tbilisi, Georgia", false],
    ["Atlanta, GA", true],
    ["Atlanta, Georgia, United States", true],
    // Other ambiguous codes after a known non-US city
    ["Bogota, CO", false],
    ["Denver, CO", true],
    ["Tel Aviv, IL", false],
    ["Chicago, IL", true],
    ["Buenos Aires, AR", false],
    // Multi-location: a US part still makes it US
    ["Toronto, ON, CA; New York, NY, US", true],
    ["Remote, Canada; New York, NY", true],
    ["Bellevue, Washington; Vancouver, Canada", true],
  ])("%j -> %j", (text, expected) => {
    expect(isUsLocation(text)).toBe(expected);
  });

  it("hasUsSignal (used for Greenhouse offices) applies the same rule", () => {
    expect(hasUsSignal("Toronto, ON, CA")).toBe(false);
    expect(hasUsSignal("Mumbai, IN")).toBe(false);
    expect(hasUsSignal("San Francisco, CA, US")).toBe(true);
    expect(hasUsSignal("Dublin, CA")).toBe(true);
  });

  it("a Lever country code still decides on its own", () => {
    expect(isUsLocation("Toronto, ON, CA", "US")).toBe(true);
    expect(isUsLocation("San Francisco, CA", "CA")).toBe(false);
  });
});

describe("reviewer nits (2026-11-20)", () => {
  it.each([
    // (a) Berlin, DE is Germany; US Berlins stay US
    ["Berlin, DE", false],
    ["Berlin, NH", true],
    ["Berlin, CT", true],
    // (b) Colombian cities with CO
    ["Medellín, CO", false],
    ["Medellin, CO", false],
    ["Bogotá, CO", false],
    ["Bogota, CO", false],
    ["Denver, CO", true],
  ])("isUsLocation(%j) -> %j", (text, expected) => {
    expect(isUsLocation(text)).toBe(expected);
  });

  it.each([
    // (c) US names containing a non-US place name
    ["New England", false],
    ["Remote - New England", false],
    ["New London", false],
    ["New Mexico", false],
    ["England", true],
    ["London", true],
    ["Medellín", true],
  ])("hasNonUsSignal(%j) -> %j", (text, expected) => {
    expect(hasNonUsSignal(text)).toBe(expected);
  });
});
