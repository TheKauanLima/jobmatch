/**
 * Student-relevance and US-location filters for external job-board listings
 * (docs/ARCHITECTURE.md §7.7.3). Greenhouse and Lever return a company's
 * *entire* open-jobs list, so the sync keeps only titles that look like
 * internships or entry-level roles, and only US (or unspecified/remote)
 * locations.
 *
 * All title matching is case-insensitive and on word boundaries. A plain
 * `\b` isn't enough for terms ending in punctuation (`sr.`, `jr.`), so each
 * alternation is wrapped in explicit "no letter/digit on either side"
 * lookarounds instead. That also makes `engineer i` refuse to match inside
 * "Engineer II" and `intern` refuse to match inside "Internal".
 */

/**
 * The two levels the sync assigns. Exactly the values of `JOB_LEVEL_FILTERS`
 * (`lib/client/jobsBoard.ts`), so the board's existing filter works unchanged.
 */
export type StudentJobLevel = "Internship" | "Entry Level";

/** Wraps alternatives in case-insensitive "whole word" lookarounds. */
function wordPattern(alternatives: readonly string[]): RegExp {
  return new RegExp(
    `(?<![a-z0-9])(?:${alternatives.join("|")})(?![a-z0-9])`,
    "i",
  );
}

/** §13.6.3, plus "counsel". A match here always drops the listing. */
export const SENIOR_TITLE_PATTERN = wordPattern([
  "senior",
  "sr\\.?",
  "staff",
  "principal",
  "lead",
  "manager",
  "director",
  "head\\s+of",
  "vp",
  "vice\\s+president",
  "chief",
  "architect",
  "distinguished",
  // Not in §13.6.3: "counsel" titles ("Associate General Counsel",
  // "Associate Commercial Counsel") are practising-lawyer roles that the
  // student term "associate" would otherwise keep (both seen live). The word
  // lookarounds mean "counselor" (e.g. healthcare) is NOT matched.
  "counsel",
]);

/** Titles that are internships (checked before the broader student pattern). */
export const INTERN_TITLE_PATTERN = wordPattern([
  "intern",
  "interns",
  "internship",
  "internships",
  "co-op",
  "coop",
  "student",
]);

/** §13.6.3, with widened spellings. Everything here that isn't an internship is "Entry Level". */
export const STUDENT_TITLE_PATTERN = wordPattern([
  "intern",
  "internship",
  "co-op",
  "coop",
  // The §13.6.3 terms, widened to common spellings the exact-spacing
  // originals missed: "New-Grad", "Newgrad", "New Grads", "Early-Career",
  // "Early Careers", "Apprenticeship", "Entry  Level".
  "new[-\\s]?grads?",
  "new[-\\s]?graduates?",
  "graduate\\s+program",
  "entry[-\\s]+level",
  "junior",
  "jr\\.?",
  "associate",
  "apprentice",
  "apprenticeships?",
  "fellowship",
  "early[-\\s]+careers?",
  "university",
  "campus",
  "student",
  "trainee",
  "analyst\\s+i",
  "engineer\\s+i",
  "level\\s+1",
]);

/**
 * Classifies a job title into one of the board's two student levels
 * (exactly `JOB_LEVEL_FILTERS`), or `null` to drop it:
 * senior terms win over everything (so "Senior Associate" and "Internship
 * Program Manager" are dropped), then internship terms, then the broader
 * student/early-career terms.
 */
export function classifyStudentLevel(title: string): StudentJobLevel | null {
  if (SENIOR_TITLE_PATTERN.test(title)) return null;
  if (INTERN_TITLE_PATTERN.test(title)) return "Internship";
  if (STUDENT_TITLE_PATTERN.test(title)) return "Entry Level";
  return null;
}

const US_STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
] as const;

const US_STATE_NAMES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
  "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
  "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
  "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
  "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
  "Washington", "West Virginia", "Wisconsin", "Wyoming", "District of Columbia",
] as const;

/** "United States", "USA", "U.S." (case-insensitive). */
const US_COUNTRY_NAME_PATTERN =
  /(?<![a-z0-9])(?:united\s+states|usa|u\.s\.(?:a\.?)?)(?![a-z0-9])/i;
/** Bare "US" as a word, case-sensitive so prose like "join us" can't match. */
const US_BARE_PATTERN = /\bUS\b/;
/**
 * A US state/DC two-letter code right after a comma (case-sensitive: ", CA").
 * Global: `hasUsStateCode` inspects every match's context.
 */
const US_STATE_CODE_PATTERN_GLOBAL = new RegExp(
  `,\\s*(${US_STATE_CODES.join("|")})(?![A-Za-z0-9])`,
  "g",
);
/** Global: `hasUsStateName` inspects every match's context. */
const US_STATE_NAME_PATTERN_GLOBAL = new RegExp(
  `(?<![a-z])(${US_STATE_NAMES.map((n) => n.replace(/ /g, "\\s+")).join("|")})(?![a-z])`,
  "gi",
);

/**
 * US state codes that are also ISO 3166-1 alpha-2 country codes ("CA" Canada,
 * "IN" India, "DE" Germany, "IL" Israel, "CO" Colombia, ...). After a non-US
 * place ("Toronto, CA", "Mumbai, IN", "Munich, DE") they mean the country.
 */
const AMBIGUOUS_STATE_CODES: ReadonlySet<string> = new Set([
  "AL", "AR", "AZ", "CA", "CO", "DE", "GA", "ID", "IL", "IN", "KY", "LA",
  "MA", "MD", "ME", "MN", "MO", "MS", "MT", "NC", "NE", "PA", "SC", "SD",
  "TN", "VA",
]);
/** US state names that are also country names ("Tbilisi, Georgia"). */
const AMBIGUOUS_STATE_NAMES: ReadonlySet<string> = new Set(["georgia"]);
/**
 * Non-US hiring cities that share a name with a US town that pairs with an
 * ambiguous code ("Dublin, CA", "London, KY", "Paris, TN", "Warsaw, IN"), so
 * they alone must not turn a state code into a country code. Berlin is
 * deliberately absent: "Berlin, DE" is Germany (US Berlins pair with NH/CT,
 * which aren't ambiguous, so "Berlin, NH" stays US anyway).
 */
const US_NAMESAKE_CITY_PATTERN =
  /(?<![\p{L}\p{N}])(?:dublin|london|paris|lisbon|warsaw|hamburg|milan|delhi|manchester|waterloo|melbourne|santiago)(?![\p{L}\p{N}])/giu;
/** Separators between location parts ("City, ST, CC; City2 • City3"). */
const LOCATION_PART_SEPARATOR = /[,;•|\n]/;

/**
 * The location part just before `index`, skipping a comma that directly
 * precedes it: for "Tbilisi, Georgia" at "Georgia" (or "Toronto, CA" at
 * ", CA") this is "Tbilisi" / "Toronto".
 */
function partBefore(text: string, index: number): string {
  const head = text.slice(0, index).replace(/[\s,]+$/, "");
  return (head.split(LOCATION_PART_SEPARATOR).pop() ?? "").trim();
}

/** True when a location part names a non-US place, ignoring US namesakes. */
function isNonUsPart(part: string): boolean {
  return hasNonUsSignal(part.replace(US_NAMESAKE_CITY_PATTERN, " "));
}

/**
 * True when the text has a `, ST` code that really is a US state:
 * - "Toronto, ON, CA" / "Bangalore, KA, IN": a code right after another,
 *   non-US two/three-letter region code sits in the country slot of the
 *   common "City, Region, CC" format, so it is a country code, not a state;
 * - "Toronto, CA" / "Mumbai, IN" / "Munich, DE": an ambiguous code right
 *   after a non-US place means the country.
 * "San Francisco, CA", "San Francisco, CA, US", "Remote, CA", "Dublin, CA"
 * stay US: there is no non-US signal next to the code.
 */
function hasUsStateCode(text: string): boolean {
  for (const match of text.matchAll(US_STATE_CODE_PATTERN_GLOBAL)) {
    const code = match[1];
    const before = partBefore(text, match.index);
    if (/^[A-Z]{2,3}$/.test(before) && !(US_STATE_CODES as readonly string[]).includes(before)) {
      continue;
    }
    if (AMBIGUOUS_STATE_CODES.has(code) && isNonUsPart(before)) continue;
    return true;
  }
  return false;
}

/** Same idea for full state names: "Tbilisi, Georgia" is the country. */
function hasUsStateName(text: string): boolean {
  for (const match of text.matchAll(US_STATE_NAME_PATTERN_GLOBAL)) {
    if (
      AMBIGUOUS_STATE_NAMES.has(match[1].toLowerCase()) &&
      isNonUsPart(partBefore(text, match.index))
    ) {
      continue;
    }
    return true;
  }
  return false;
}
/** Empty, or only "Remote"/"Anywhere" with optional surrounding punctuation. */
const REMOTE_ONLY_PATTERN = /^[\s\p{P}]*(?:remote|anywhere)?[\s\p{P}]*$/iu;

/**
 * US-location policy (§7.7.3):
 * - a Lever `country` code, when present, decides on its own (`=== "US"`);
 * - otherwise keep text containing a US signal (country name, `, ST` state
 *   code, or full state name), anywhere in the text, so multi-location text
 *   counts as US when any part is;
 * - also keep empty/"Remote"/"Anywhere"-only text (may not be US-only, but
 *   dropping it would lose real remote roles);
 * - drop everything else (including `Toronto, ON` / `Vancouver, BC`).
 */
export function isUsLocation(
  text: string | null,
  countryCode?: string | null,
): boolean {
  const country = countryCode?.trim();
  if (country) {
    return country.toUpperCase() === "US";
  }

  const location = text ?? "";
  if (REMOTE_ONLY_PATTERN.test(location)) return true;

  return hasUsSignal(location);
}

/**
 * True only when the text contains a *positive* US signal (country name,
 * `, ST` state code, or full state name). Unlike `isUsLocation`, empty and
 * "Remote"/"Anywhere"-only text return false. Used for secondary location
 * fields (Greenhouse `offices[]`), where a blank or bare "Remote" value
 * must not rescue a listing whose primary location was rejected.
 *
 * A `, ST` code or state name only counts when its context doesn't make it
 * a country ("Toronto, ON, CA", "Mumbai, IN", "Tbilisi, Georgia"); see
 * `hasUsStateCode`. This also applies to Lever text when `country` is absent.
 */
export function hasUsSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    US_COUNTRY_NAME_PATTERN.test(text) ||
    US_BARE_PATTERN.test(text) ||
    hasUsStateCode(text) ||
    hasUsStateName(text)
  );
}

/**
 * Countries, Canadian provinces, and major non-US hiring cities that mark a
 * location as explicitly outside the US. Not exhaustive: it only needs to
 * recognise the places that actually show up on the boards we poll, so a
 * Greenhouse `location.name` like "Toronto" or "Remote Canada" is never
 * overridden by a US office (§7.7.3 amendment). City names that are also
 * common US place names (e.g. Cambridge) are deliberately left out.
 */
const NON_US_PLACE_NAMES = [
  // Countries / regions
  "Canada", "Mexico", "Brazil", "Argentina", "Colombia", "Chile", "Peru",
  "Costa Rica", "United Kingdom", "England", "Scotland", "Wales",
  "Northern Ireland", "Ireland", "Germany", "France", "Spain", "Portugal",
  "Italy", "Netherlands", "Belgium", "Luxembourg", "Switzerland", "Austria",
  "Poland", "Czech Republic", "Czechia", "Romania", "Serbia", "Croatia",
  "Greece", "Denmark", "Sweden", "Norway", "Finland", "Estonia", "Lithuania",
  "Latvia", "Ukraine", "Turkey", "Israel", "United Arab Emirates", "UAE",
  "Saudi Arabia", "Egypt", "Nigeria", "Kenya", "South Africa", "India",
  "Pakistan", "Singapore", "Malaysia", "Indonesia", "Philippines", "Vietnam",
  "Thailand", "Japan", "South Korea", "Korea", "China", "Hong Kong",
  "Taiwan", "Australia", "New Zealand", "EMEA", "APAC", "LATAM", "Europe",
  // Canadian provinces
  "Ontario", "British Columbia", "Quebec", "Québec", "Alberta", "Manitoba",
  "Saskatchewan", "Nova Scotia", "New Brunswick", "Newfoundland",
  // Major non-US hiring cities
  "Toronto", "Vancouver", "Montreal", "Montréal", "Ottawa", "Calgary",
  "Waterloo", "London", "Dublin", "Edinburgh", "Manchester", "Paris",
  "Berlin", "Munich", "Hamburg", "Amsterdam", "Madrid", "Barcelona",
  "Lisbon", "Lisboa", "Milan", "Zurich", "Zürich", "Stockholm",
  "Copenhagen", "Aarhus", "Oslo", "Helsinki", "Warsaw", "Krakow", "Kraków",
  "Prague", "Belgrade", "Bucharest", "Tel Aviv", "Dubai", "Bangalore",
  "Bengaluru", "Hyderabad", "Pune", "Mumbai", "Chennai", "Gurgaon",
  "Gurugram", "Noida", "Delhi", "Tokyo", "Seoul", "Shanghai", "Beijing",
  "Shenzhen", "Taipei", "Sydney", "Melbourne", "São Paulo", "Sao Paulo",
  "Mexico City", "Ciudad de México", "Bogotá", "Bogota", "Buenos Aires",
  "Santiago", "Tbilisi", "Medellín", "Medellin",
] as const;

const NON_US_PLACE_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${NON_US_PLACE_NAMES.map((n) => n.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);
/** "UK" / "U.K." (case-sensitive so it can't match inside prose). */
const UK_PATTERN = /(?<![A-Za-z0-9])U\.?K\.?(?![A-Za-z0-9])/;
/** A Canadian province/territory code right after a comma (", ON"). */
const CA_PROVINCE_CODE_PATTERN =
  /,\s*(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)(?![A-Za-z0-9])/;

/**
 * True when the text names a place explicitly outside the US (country,
 * Canadian province, or major non-US city). Used together with
 * `isUsLocation` to decide whether a Greenhouse `location.name` is
 * "placeless" (neither signal) and so may fall back to `offices[]`.
 */
export function hasNonUsSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  // US names containing a non-US place name: "New Mexico" (a state, not
  // Mexico), "New England" (a US region, not England), "New London" (CT).
  const withoutUsLookalikes = text.replace(
    /new\s+(?:mexico|england|london)/gi,
    " ",
  );
  return (
    NON_US_PLACE_PATTERN.test(withoutUsLookalikes) ||
    UK_PATTERN.test(withoutUsLookalikes) ||
    CA_PROVINCE_CODE_PATTERN.test(withoutUsLookalikes)
  );
}
