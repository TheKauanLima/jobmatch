import { createHash } from "node:crypto";

import type { JobRemoteType } from "@/types/database";

/**
 * Cross-source dedupe normalization (docs/ARCHITECTURE.md §13.6.4).
 *
 * `dedupe_key = sha256(company|title|location).slice(0, 32)` over the
 * normalized parts below. It's null when the company is unknown (or
 * normalizes to nothing): without the company a match is too ambiguous to
 * merge. User-submitted rows never get a key (enforced by a 0009 check).
 *
 * Pure functions, no I/O. The same key must come out for the same listing
 * whichever source it came from, so every adapter feeds these through
 * `computeDedupeKey` rather than building keys itself.
 */

/** Trailing legal suffixes dropped from company names (§13.6.4). */
export const COMPANY_LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "gmbh",
  "lp",
  "llp",
]);

/** Title tokens that describe the workplace, not the role (§13.6.4). */
const TITLE_WORKPLACE_TOKENS: ReadonlySet<string> = new Set([
  "remote",
  "hybrid",
  "onsite",
]);

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * NFKC → lowercase → strip punctuation → drop trailing legal suffixes →
 * collapse whitespace.
 *
 * "Strip punctuation": dots and apostrophes are removed outright, so
 * abbreviations and possessives survive as one token ("J.P. Morgan" →
 * "jp morgan", "Macy's" → "macys"). Every other punctuation or symbol
 * character becomes a space ("Acme,Inc" → "acme inc", "AT&T" → "at t").
 * Suffixes are dropped repeatedly ("Acme Co., Inc." → "acme") but never the
 * last remaining token, so a company literally named "Company" keeps it.
 */
export function normalizeCompany(company: string): string {
  const base = collapseWhitespace(
    company
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[.'’]/gu, "")
      .replace(/[\p{P}\p{S}]/gu, " "),
  );
  const tokens = base.length > 0 ? base.split(" ") : [];
  while (tokens.length > 1 && COMPANY_LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

/**
 * NFKC → lowercase → drop `(...)` / `[...]` segments → separators
 * `[-–—|/,:]` → space → drop the tokens remote/hybrid/onsite/on-site →
 * collapse whitespace.
 */
export function normalizeTitle(title: string): string {
  const base = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\([^)]*\)/gu, " ")
    .replace(/\[[^\]]*\]/gu, " ")
    // "on-site" is one token in §13.6.4; drop it before "-" becomes a space.
    .replace(/(?<![\p{L}\p{N}])on-site(?![\p{L}\p{N}])/gu, " ")
    .replace(/[-–—|/,:]/gu, " ");
  return collapseWhitespace(base)
    .split(" ")
    .filter((token) => token.length > 0 && !TITLE_WORKPLACE_TOKENS.has(token))
    .join(" ");
}

export type PrimaryLocation = {
  city: string | null;
  region: string | null;
  country: string | null;
};

function normalizeLocationPart(part: string | null): string {
  return part ? collapseWhitespace(part.normalize("NFKC").toLowerCase()) : "";
}

/**
 * `remote` if the listing is remote; else `city|region|country` lowercased;
 * else `''` (§13.6.4).
 */
export function normalizePrimaryLocation(
  remoteType: JobRemoteType | null,
  primaryLocation: PrimaryLocation | null,
): string {
  if (remoteType === "remote") return "remote";
  if (!primaryLocation) return "";
  const parts = [primaryLocation.city, primaryLocation.region, primaryLocation.country].map(
    normalizeLocationPart,
  );
  return parts.every((part) => part === "") ? "" : parts.join("|");
}

/** Length of the hex prefix kept from the sha256 (§13.6.4). */
export const DEDUPE_KEY_LENGTH = 32;

export function computeDedupeKey(input: {
  company: string | null;
  title: string;
  remoteType: JobRemoteType | null;
  primaryLocation: PrimaryLocation | null;
}): string | null {
  if (input.company === null) return null;
  const company = normalizeCompany(input.company);
  if (company === "") return null;
  const title = normalizeTitle(input.title);
  const location = normalizePrimaryLocation(input.remoteType, input.primaryLocation);
  return createHash("sha256")
    .update(`${company}|${title}|${location}`, "utf8")
    .digest("hex")
    .slice(0, DEDUPE_KEY_LENGTH);
}
