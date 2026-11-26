/**
 * Deterministic "Field" classification for the job board
 * (docs/ARCHITECTURE.md §7.8.3). One category per job, from the title plus
 * the source's department/team. The description is never used (every
 * posting mentions "engineering", "data", and "sales").
 *
 * Precedence, first hit wins:
 * - Tier A: specific (non-generic) rules against the title;
 * - Tier B: specific rules against the department;
 * - Tier C: generic rules ("engineer", "analyst", ...) against the title;
 * - otherwise `other`.
 * A specific title ("Recruiting Coordinator") beats the department, and the
 * department beats a vague title ("Summer Intern", "Analyst").
 *
 * Pinned by the golden test in classifyCategory.test.ts (real titles and
 * departments from the live board). Change rules only together with it.
 */

import type { JobCategory } from "@/lib/jobs/categories";

type CategoryRule = {
  category: JobCategory;
  match: RegExp;
  unless?: RegExp;
};

/** Whole-word alternation over normalized (lowercase, space-separated) text. */
function words(alternatives: readonly string[]): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${alternatives.join("|")})(?![a-z0-9])`);
}

/**
 * Specific rules (tiers A and B), in precedence order. Some categories have
 * two entries: a strong one with no `unless`, and a weaker one that yields
 * to a more specific category.
 */
const SPECIFIC_RULES: readonly CategoryRule[] = [
  {
    category: "people-hr",
    match: words([
      "recruit[a-z]*",
      "talent acquisition",
      "human resources",
      "hr",
      "people (?:operations|ops|partners?|team|transformation|experience|programs?)",
      "compensation",
      "benefits",
      "employee",
    ]),
    // "Forward Deployed Engineer (HR Technology)" is an engineering role.
    unless: words(["engineer[a-z]*", "developer", "software"]),
  },
  {
    category: "legal",
    match: words([
      "legal",
      "counsel",
      "paralegal",
      "attorney",
      "lawyer",
      "compliance",
      "policy",
      "regulatory",
      "government affairs",
      "privacy",
    ]),
    // "Privacy & Civil Liberties Engineer" is an engineering role.
    unless: words(["engineer[a-z]*", "software"]),
  },
  {
    category: "it-security",
    match: /(?<![a-z0-9])(?:security|cyber[a-z]*|infosec|information technology|help ?desk|desktop support|sysadmin|systems? administrat[a-z]*|network (?:engineer|administrator|technician)[a-z]*|(?:technical )?support engineer[a-z]*|data cent(?:er|re))(?![a-z0-9])|\u0000IT\u0000/,
    // "Software Dev Engineer I - Security Platform" is software; "IT Channel
    // Marketing Intern" is marketing.
    unless: words(["software", "developer", "dev", "marketing", "sales"]),
  },
  {
    category: "design",
    match: words([
      "design[a-z]*",
      "ux",
      "ui",
      "user experience",
      "user research",
      "visual",
      "graphics?",
      "illustrat[a-z]*",
      "creative",
      "motion",
      "animat[a-z]*",
    ]),
    // "Design Engineering", "Electrical Design Intern" are engineering.
    unless: words(["engineer[a-z]*", "electrical", "mechanical", "circuit", "pcb", "structural", "civil"]),
  },
  {
    category: "data",
    match: words([
      "machine learning",
      "data scien[a-z]*",
      "data analy[a-z]*",
      "data engineer[a-z]*",
      "analytics",
      "business intelligence",
      "bi",
      "deep learning",
      "computer vision",
      "nlp",
      "statistic[a-z]*",
      "quantitative research[a-z]*",
    ]),
  },
  {
    // Weak AI terms yield to an explicit software title:
    // "Software Engineer, Internship - Sovereign AI Systems".
    category: "data",
    match: words(["ai", "ml", "artificial intelligence", "genai", "gen ai", "generative ai", "llms?"]),
    unless: words(["software", "developer", "frontend", "front end", "backend", "back end", "full ?stack"]),
  },
  {
    category: "product",
    match: words(["product manag[a-z]*", "product owner", "apm", "product analyst"]),
    unless: words(["marketing"]),
  },
  {
    // Pre-sales engineering titles are sales roles despite "engineer".
    category: "sales-marketing",
    match: words(["sales engineer[a-z]*", "solutions? engineer[a-z]*", "solutions consultant"]),
  },
  {
    category: "sales-marketing",
    match: words([
      "marketing",
      "sales",
      "account (?:executive|manager|development)",
      "business development",
      "sales development",
      "bdr",
      "sdr",
      "go to market",
      "gtm",
      "communications",
      "social media",
      "content",
      "brand",
      "public relations",
      "customer success",
      "partnerships?",
      // Retail floor roles, consistent with "Part Time Sales Associate".
      "retail",
      "store associates?",
    ]),
    // "Advanced RF Communications" is a hardware (radio) role.
    unless: words(["engineer[a-z]*", "rf", "radio frequency", "wireless"]),
  },
  {
    category: "finance",
    match: words([
      "financ[a-z]*",
      "accounting",
      "accountant",
      "audit[a-z]*",
      "tax",
      "treasury",
      "payroll",
      "investments?",
      "investor relations",
      "banking",
      "trader",
      "trading",
      "actuar[a-z]*",
      "fp&a",
      "controller",
      "credit",
      "underwrit[a-z]*",
      "equity research",
      "broker",
      "risk",
      "mortgage",
      "loan",
    ]),
  },
  {
    category: "healthcare",
    match: words([
      "nurs[a-z]*",
      "clinical",
      "medical",
      "physician",
      "pharmac[a-z]*",
      "therap[a-z]*",
      "healthcare",
      "patient",
      "dental",
      "phlebotom[a-z]*",
      "rn",
      "emt",
    ]),
    unless: words(["software", "engineer[a-z]*", "data"]),
  },
  {
    category: "trades",
    match: words([
      "construction",
      "electrician",
      "plumb[a-z]*",
      "carpent[a-z]*",
      "hvac",
      "weld[a-z]*",
      "mason",
      "superintendent",
      "foreman",
      "foreperson",
      "journeyman",
      "apprentice",
      "mechanic",
      "machinist",
      "maintenance",
      "installer",
      "field service",
      "technician",
      "estimator",
      "(?:loader|process|machine|equipment|forklift) operators?",
    ]),
    unless: words(["software", "engineer[a-z]*", "developer", "data", "lab", "laborator[a-z]*"]),
  },
  {
    // Non-software engineering titles ("Junior Commissioning Engineer",
    // "Tendering Project Engineer Intern", "Junior Engineer - Tool Room"),
    // unless a software/data signal is present.
    category: "hardware",
    match: words([
      "(?:commissioning|project|field|manufacturing|process|quality) engineer[a-z]*",
      "tool ?room",
    ]),
    unless: words([
      "software", "developers?", "data", "ai", "ml", "machine learning", "cloud",
      "platform", "web", "devops", "full ?stack", "front ?end", "back ?end",
    ]),
  },
  {
    // Firmware/embedded are hardware even next to "software".
    category: "hardware",
    match: words(["firmware", "embedded"]),
  },
  {
    category: "hardware",
    match: words([
      "mechanical",
      "electrical",
      "electronics?",
      "hardware",
      "asic",
      "fpga",
      "silicon",
      "circuits?",
      "rf",
      "radio frequency",
      "aerospace",
      "avionics",
      "propulsion",
      "robotics",
      "manufacturing",
      "industrial",
      "civil(?! liberties)",
      "structural",
      "chemical",
      "materials",
      "mechatronics",
      "(?:test|validation|reliability|systems?|safety) engineer[a-z]*",
      "controls",
      "optical",
      "photonics?",
      "photovoltaics?",
      "battery",
      "vehicle",
    ]),
    unless: words(["software"]),
  },
  {
    category: "science",
    match: words([
      "research[a-z]*",
      "scientists?",
      "laborator[a-z]*",
      "lab",
      "biolog[a-z]*",
      "chemist[a-z]*",
      "physic[a-z]*",
      "biotech[a-z]*",
      "geolog[a-z]*",
      "environmental",
      "r&d",
    ]),
    unless: words(["engineer[a-z]*", "software", "developer"]),
  },
  {
    category: "software",
    match: words([
      "software",
      "developers?",
      "swe",
      "sde",
      "front ?end",
      "back ?end",
      "full ?stack",
      "ios",
      "android",
      "devops",
      "site reliability",
      "sre",
      "programmer",
    ]),
  },
  {
    // Weak software terms yield to business titles:
    // "Infrastructure Business Operations Associate", "Management Trainee - St. Cloud".
    category: "software",
    match: words(["web", "mobile", "platform", "infrastructure", "cloud"]),
    unless: words(["operations", "business", "strateg[a-z]*", "management trainee"]),
  },
  {
    category: "business-ops",
    match: words([
      "operations",
      "ops",
      "strateg[a-z]*",
      "consult[a-z]*",
      "business analyst",
      "program manag[a-z]*",
      "project manag[a-z]*",
      "supply chain",
      "logistics",
      "procurement",
      "sourcing",
      "warehouse",
      "customer (?:support|service|experience|care|assistance)",
      "member service",
      "trust & safety",
      "chief of staff",
      "executive assistant",
      "administrative",
      "admin",
      "management trainee",
      "pricing",
      "monetization",
      "real estate",
      "facilities",
    ]),
  },
];

/** Generic rules (tier C), title only. */
const GENERIC_RULES: readonly CategoryRule[] = [
  { category: "software", match: words(["engineer", "engineers", "engineering"]) },
  { category: "business-ops", match: words(["analyst", "associate", "coordinator", "specialist"]) },
];

/**
 * Department words that describe the hiring *program*, not the job
 * ("University Recruiting - Engineering" must not read as recruiting).
 */
const DEPARTMENT_PROGRAM_NOISE =
  /(?<![a-z0-9])(?:university|campus|early (?:careers?|talent)|emerging talent|graduate|new grad) recruit[a-z]*(?![a-z0-9])/g;

/**
 * Lowercase, collapse whitespace, and treat separators
 * (`/ , - ( ) |`, plus brackets, colons, semicolons and dashes) as spaces.
 * `&` and `+` are kept ("r&d", "fp&a", "trust & safety"). The case-sensitive
 * `IT` token is rewritten to a sentinel before lowercasing, so "IT Engineer"
 * matches the it-security rule but "it" in prose never does.
 */
function normalize(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])IT(?![A-Za-z0-9])/g, " \u0000IT\u0000 ")
    .replace(/[/,\-()|[\]{}:;–—•.!?"']/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/\u0000it\u0000/g, "\u0000IT\u0000")
    .trim();
}

function firstMatch(rules: readonly CategoryRule[], text: string): JobCategory | null {
  if (!text) return null;
  for (const rule of rules) {
    if (rule.match.test(text) && !(rule.unless && rule.unless.test(text))) {
      return rule.category;
    }
  }
  return null;
}

/** Assigns one §7.8.3 field to a job from its title and (optional) department. */
export function classifyJobCategory({
  title,
  department,
}: {
  title: string;
  department?: string | null;
}): JobCategory {
  const normalizedTitle = normalize(title);
  const normalizedDepartment = department
    ? normalize(department).replace(DEPARTMENT_PROGRAM_NOISE, " ").trim()
    : "";

  return (
    firstMatch(SPECIFIC_RULES, normalizedTitle) ??
    firstMatch(SPECIFIC_RULES, normalizedDepartment) ??
    firstMatch(GENERIC_RULES, normalizedTitle) ??
    "other"
  );
}
