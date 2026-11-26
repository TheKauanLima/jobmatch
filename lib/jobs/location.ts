/**
 * Location facets for the job-board filters (docs/ARCHITECTURE.md §7.8.2):
 * which US states (plus DC) a free-text `location` names, and whether it is
 * explicitly remote. Pure; computed at write time by `lib/jobs/facets.ts`
 * and stored in `job_descriptions.location_states` / `is_remote`.
 *
 * Rules, in order (output deduped and sorted by code):
 * 1. DC first ("Washington, D.C.", "District of Columbia", "D.C."); the
 *    matched text is removed so it doesn't also add WA.
 * 2. Uppercase two-letter state codes in a location slot (after ", ",
 *    " - ", "(", or at the start of a segment; followed by ",", ";", ")",
 *    " - ", a ZIP, " US"/" USA", " or"/" and", "/", or the end).
 * 3. Full state names, case-insensitive, whole words.
 * 4. A small table of unambiguous city/metro aliases.
 * 5. Remote: "remote", "anywhere", "work from home", "WFH", or `hints.remote`.
 *    "Hybrid" is not remote.
 * 6. A remote job keeps its states ("Remote - ME" → ME + remote).
 * 7. Anything else adds nothing.
 *
 * Codes and names that are really countries in context ("Toronto, CA",
 * "Tbilisi, Georgia") are skipped using the same disambiguation as the
 * §7.7.3 US filter (`lib/jobs/studentFilter.ts`).
 *
 * A state name (rule 3) or city alias (rule 4) whose location part is
 * followed by a *different* state code is a town, not that state:
 * "Delaware, OH", "Michigan City, IN", "Washington, PA", "Brooklyn Park, MN",
 * "Austin, MN".
 */

import { isStateCodeUsedAsCountry, isStateNameUsedAsCountry } from "@/lib/jobs/studentFilter";
import { isUsStateCode, US_STATES, type UsStateCode } from "@/lib/jobs/usStates";

export type LocationFacets = { states: UsStateCode[]; isRemote: boolean };

/** Rule 1. "Washington, D.C.", "Washington DC", "District of Columbia", standalone "D.C.". */
const DC_PATTERN =
  /\bWashington,?\s*D\.?\s?C\b\.?|\bDistrict\s+of\s+Columbia\b|(?<![A-Za-z0-9])D\.C\.?(?![A-Za-z0-9])/gi;

/**
 * Rule 2. `(?<=…)` = the code starts a location slot; `(?=…)` = it ends one.
 * Case-sensitive on purpose: "in"/"or"/"me" in prose never match.
 */
const STATE_CODE_PATTERN =
  /(?<=(?:^|;|,|\(|\s[-–—]|^[-–—])\s*)([A-Z]{2})(?=\s*$|\s*[,;)/]|\s+[-–—]\s|\s+\d{5}\b|\s+USA?\b|\s+(?:or|and)\b)/g;

/** Rule 3. Longest names first so "West Virginia" wins over "Virginia". */
const STATE_NAME_TO_CODE = new Map<string, UsStateCode>(
  (Object.entries(US_STATES) as [UsStateCode, string][])
    .filter(([code]) => code !== "DC") // handled by rule 1
    .map(([code, name]) => [name.toLowerCase(), code]),
);
const STATE_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z])(${[...STATE_NAME_TO_CODE.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/ /g, "\\s+"))
    .join("|")})(?![A-Za-z])`,
  "gi",
);

/**
 * Rule 4. Unambiguous city/metro names only: Portland, Cambridge, Columbus,
 * and a bare "Washington" (the state, via rule 3) are deliberately absent.
 */
const CITY_ALIASES: ReadonlyArray<readonly [string, UsStateCode]> = [
  ["San Francisco", "CA"],
  ["Bay Area", "CA"],
  ["Silicon Valley", "CA"],
  ["Palo Alto", "CA"],
  ["Mountain View", "CA"],
  ["Menlo Park", "CA"],
  ["Sunnyvale", "CA"],
  ["San Jose", "CA"],
  ["San Mateo", "CA"],
  ["Foster City", "CA"],
  ["Los Angeles", "CA"],
  ["San Diego", "CA"],
  ["Irvine", "CA"],
  ["NYC", "NY"],
  ["New York City", "NY"],
  ["Brooklyn", "NY"],
  ["Manhattan", "NY"],
  ["Seattle", "WA"],
  ["Bellevue", "WA"],
  ["Redmond", "WA"],
  ["Austin", "TX"],
  ["Dallas", "TX"],
  ["Houston", "TX"],
  ["Chicago", "IL"],
  ["Boston", "MA"],
  ["Denver", "CO"],
  ["Boulder", "CO"],
  ["Atlanta", "GA"],
  ["Pittsburgh", "PA"],
  ["Philadelphia", "PA"],
  ["Miami", "FL"],
  ["Phoenix", "AZ"],
  ["Nashville", "TN"],
  ["Salt Lake City", "UT"],
];
const CITY_ALIAS_PATTERNS: ReadonlyArray<readonly [RegExp, UsStateCode]> =
  CITY_ALIASES.map(([name, code]) => [
    new RegExp(`(?<![A-Za-z])${name.replace(/ /g, "\\s+")}(?![A-Za-z])`, "gi"),
    code,
  ]);

/**
 * The US state code that forms the location part right after `end`, or null:
 * "Delaware|, OH" → OH, "Michigan| City, IN" → IN, "Brooklyn| Park, MN" → MN
 * (words before the comma belong to the same part). Only a bare uppercase
 * code (optionally with a ZIP) counts: a following state *name* is too often
 * the next location in a list ("San Francisco, Seattle, New York").
 */
function explicitStateCodeAfter(text: string, end: number): UsStateCode | null {
  const next = /^[^,;]*,\s*([^,;]+?)\s*(?=[,;]|$)/.exec(text.slice(end));
  if (!next) return null;
  const code = /^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(next[1])?.[1];
  return code && isUsStateCode(code) ? code : null;
}

/** Rule 5. */
const REMOTE_PATTERN = /\bremote\b|\banywhere\b|\bwork\s+from\s+home\b|\bWFH\b/i;

/**
 * Parses a free-text location into state codes and a remote flag
 * (§7.8.2). `hints.remote` comes from a source field (Lever
 * `workplaceType === "remote"`).
 */
export function parseLocationFacets(
  location: string | null,
  hints?: { remote?: boolean },
): LocationFacets {
  const states = new Set<UsStateCode>();
  const original = location ?? "";

  // Rule 1: DC, removed before the other rules so "Washington, D.C." isn't WA.
  const text = original.replace(DC_PATTERN, " ");
  if (text !== original) {
    states.add("DC");
  }

  // Bullets, pipes and newlines separate locations the same way ";" does.
  const segmented = text.replace(/\s*[•|\n]\s*/g, "; ");

  // Rule 2: two-letter codes in a location slot.
  for (const match of segmented.matchAll(STATE_CODE_PATTERN)) {
    const code = match[1];
    if (!isUsStateCode(code)) continue;
    if (isStateCodeUsedAsCountry(segmented, match.index, code)) continue;
    states.add(code);
  }

  // Rule 3: full state names.
  for (const match of segmented.matchAll(STATE_NAME_PATTERN)) {
    if (isStateNameUsedAsCountry(segmented, match.index, match[1])) continue;
    const code = STATE_NAME_TO_CODE.get(match[1].toLowerCase().replace(/\s+/g, " "));
    if (!code) continue;
    const after = explicitStateCodeAfter(segmented, match.index + match[0].length);
    if (after && after !== code) continue; // "Delaware, OH", "Michigan City, IN"
    states.add(code);
  }

  // Rule 4: city/metro aliases.
  for (const [pattern, code] of CITY_ALIAS_PATTERNS) {
    for (const match of segmented.matchAll(pattern)) {
      const after = explicitStateCodeAfter(segmented, match.index + match[0].length);
      if (after && after !== code) continue; // "Brooklyn Park, MN", "Austin, MN"
      states.add(code);
      break;
    }
  }

  // Rules 5–6: remote is independent of the states.
  const isRemote = hints?.remote === true || REMOTE_PATTERN.test(original);

  return { states: [...states].sort(), isRemote };
}
