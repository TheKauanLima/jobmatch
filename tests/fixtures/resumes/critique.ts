/**
 * Synthetic resume and critique fixtures for the V1 critique tests
 * (docs/ARCHITECTURE.md §13.20, ROADMAP V1.1 acceptance). Made-up person,
 * reserved `.test` domain, no real personal data.
 *
 * `UNICODE_RESUME` deliberately contains characters NFKC changes (`m²`,
 * `™`, `½`, full-width digits, the `ﬁ`/`ﬂ` ligatures) and an invisible
 * zero-width space, so quotes Claude returns (NFKC, invisibles stripped)
 * differ from the stored text and must be mapped back (§13.13.2).
 */

import type { CritiqueResumeOutput } from "@/lib/claude/tasks/critiqueResume";

const ZWSP = "​";

export const UNICODE_RESUME = [
  "Alex Example",
  "alex.example@example.test | (555) 010-0000",
  "",
  "OBJECTIVE",
  "Mechanical engineering student seeking a summer internship in sustainable building design.",
  "",
  "EDUCATION",
  "State Technical University – B.S. Mechanical Engineering, expected May 2027",
  "",
  "EXPERIENCE",
  "Facilities Intern, Campus Energy Office (Summer 2025)",
  "• Helped with HVAC audits for 12 buildings totaling 40,000 m² of floor space",
  `• Respon${ZWSP}sible for updating spreadsheets`,
  "• Worked on a team that reduced energy use",
  "",
  "PROJECTS",
  "• Designed a ½-scale wind turbine prototype in SolidWorks™",
  "• Built an Arduino airﬂow sensor (ﬁrst place, campus design fair)",
  "• Logged ３５ wind-tunnel test runs",
  "",
  "SKILLS",
  "SolidWorks™, MATLAB, Python, AutoCAD",
].join("\n");

/** What Claude would quote for each bullet: the NFKC, invisible-free form it saw. */
export const NFKC_QUOTES = {
  hvac: "Helped with HVAC audits for 12 buildings totaling 40,000 m2 of floor space",
  spreadsheets: "Responsible for updating spreadsheets",
  team: "Worked on a team that reduced energy use",
  turbine: "Designed a 1⁄2-scale wind turbine prototype in SolidWorksTM",
  airflow: "Built an Arduino airflow sensor (first place, campus design fair)",
  tunnel: "Logged 35 wind-tunnel test runs",
} as const;

/** The exact stored characters each quote must map back to. */
export const ORIGINAL_SPANS = {
  hvac: "Helped with HVAC audits for 12 buildings totaling 40,000 m² of floor space",
  spreadsheets: `Respon${ZWSP}sible for updating spreadsheets`,
  team: "Worked on a team that reduced energy use",
  turbine: "Designed a ½-scale wind turbine prototype in SolidWorks™",
  airflow: "Built an Arduino airﬂow sensor (ﬁrst place, campus design fair)",
  tunnel: "Logged ３５ wind-tunnel test runs",
} as const;

type LineItem = CritiqueResumeOutput["line_feedback"][number];

export function lineItem(overrides: Partial<LineItem> = {}): LineItem {
  return {
    section: "experience",
    original_text: NFKC_QUOTES.team,
    issue_types: ["vague", "no_metric"],
    feedback: "Say what you did and what changed.",
    suggested_rewrite: "Analyzed meter data with a team, cutting energy use by [X%]",
    needs_user_input: true,
    ...overrides,
  };
}

/** A schema-valid critique output for `UNICODE_RESUME` (dimensions deliberately out of order). */
export function critiqueOutput(overrides: Partial<CritiqueResumeOutput> = {}): CritiqueResumeOutput {
  return {
    summary: "A promising resume with strong projects; the experience bullets need results.",
    student_context: { stage: "late_student", note: "Projects are weighted as heavily as work experience." },
    dimensions: [
      { dimension: "structure", score: 80, rationale: "Clear sections.", top_fix: "Move Projects above Experience." },
      { dimension: "impact", score: 58, rationale: "Few results.", top_fix: "Add outcomes to each bullet." },
      { dimension: "ats_readability", score: 72, rationale: "Mostly plain text.", top_fix: "Use standard headings." },
      { dimension: "clarity", score: 66, rationale: "Some vague lines.", top_fix: "Replace 'responsible for' with verbs." },
      { dimension: "relevance", score: 81, rationale: "Matches the stated goal.", top_fix: "Name building-energy tools." },
    ],
    line_feedback: [
      lineItem({
        original_text: NFKC_QUOTES.hvac,
        issue_types: ["weak_verb"],
        suggested_rewrite: "Audited HVAC systems in 12 buildings covering 40,000 m2",
        needs_user_input: false,
      }),
      lineItem({
        original_text: NFKC_QUOTES.spreadsheets,
        issue_types: ["weak_verb", "vague"],
        suggested_rewrite: "Maintained energy-tracking spreadsheets for [number of] buildings",
        needs_user_input: true,
      }),
      lineItem(),
      lineItem({
        section: "projects",
        original_text: NFKC_QUOTES.turbine,
        issue_types: ["no_metric"],
        suggested_rewrite: "Designed and modeled a 1⁄2-scale wind turbine in SolidWorksTM, reaching [X W] output",
        needs_user_input: true,
      }),
      lineItem({
        section: "projects",
        original_text: NFKC_QUOTES.airflow,
        issue_types: ["vague"],
        suggested_rewrite: "Built an Arduino airflow sensor that won first place at the campus design fair",
        needs_user_input: false,
      }),
      lineItem({
        section: "projects",
        original_text: NFKC_QUOTES.tunnel,
        issue_types: ["no_metric"],
        suggested_rewrite: "Ran 35 wind-tunnel tests to validate [design parameter]",
        needs_user_input: true,
      }),
    ],
    section_feedback: [{ section: "EXPERIENCE", feedback: "Lead with outcomes." }],
    ats_issues: [{ issue: "Contact line uses a pipe separator.", fix: "Put email and phone on separate lines." }],
    missing_sections: ["Leadership"],
    ...overrides,
  };
}
