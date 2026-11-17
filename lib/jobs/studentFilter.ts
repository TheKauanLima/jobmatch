/**
 * Student-relevance title filter for board sources (docs/ARCHITECTURE.md
 * §13.6.3). Greenhouse/Lever boards return every job a company has, so
 * listings are filtered before upsert to bound storage and extraction cost.
 * The Muse (level filter at source) and USAJOBS (hiring-path filter at
 * source) skip it: `lib/jobs/sync.ts` applies it only to board syncs.
 *
 * Matching is case-insensitive with letter/digit boundaries (not `\b`,
 * which fails after the dot in "Jr." / "Sr."). "Analyst I" therefore does
 * not match "Analyst II", and "Level 1" does not match "Level 10".
 */

const STUDENT_TERMS = [
  "intern",
  "internship",
  "co-op",
  "coop",
  "new grad",
  "new graduate",
  "graduate program",
  // §13.6.3 writes this as `entry[- ]level`; \s keeps the " " → \s+ rewrite
  // in boundedPattern from touching the character class.
  "entry[-\\s]level",
  "junior",
  "jr\\.?",
  "associate",
  "apprentice",
  "fellowship",
  "early career",
  "university",
  "campus",
  "student",
  "trainee",
  "analyst i",
  "engineer i",
  "level 1",
];

const SENIOR_TERMS = [
  "senior",
  "sr\\.?",
  "staff",
  "principal",
  "lead",
  "manager",
  "director",
  "head of",
  "vp",
  "vice president",
  "chief",
  "architect",
  "distinguished",
];

function boundedPattern(terms: string[]): RegExp {
  // Multi-word terms match any run of whitespace between their words.
  const alternation = terms.map((t) => t.replace(/ /g, "\\s+")).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, "iu");
}

export const STUDENT_TITLE_PATTERN = boundedPattern(STUDENT_TERMS);
export const SENIOR_TITLE_PATTERN = boundedPattern(SENIOR_TERMS);

/**
 * Keep when the title matches STUDENT; also keep an unlabeled title (matches
 * neither) when the board opted in with `include_unlabeled_titles`. Drop
 * whenever SENIOR matches, even alongside STUDENT ("Senior Associate").
 */
export function isStudentRelevantTitle(
  title: string,
  options: { includeUnlabeledTitles: boolean },
): boolean {
  const normalized = title.normalize("NFKC");
  if (SENIOR_TITLE_PATTERN.test(normalized)) return false;
  if (STUDENT_TITLE_PATTERN.test(normalized)) return true;
  return options.includeUnlabeledTitles;
}
