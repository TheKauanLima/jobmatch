/**
 * A synthetic, fully-populated `Critique` (the §13.20.4 API object) for the
 * critique UI tests (components/reports/*, RunCritiqueButton). Made-up
 * content, no real personal data. `original_text` values keep characters a
 * normalizer would change (`m²`, `™`, `½`, a full-width digit) so tests can
 * assert they render exactly as received.
 */

import type { Critique, LineFeedback } from "@/types/domain";

const LINE_FEEDBACK: LineFeedback[] = [
  {
    id: "lf_0",
    section: "experience",
    original_text: "Helped with HVAC audits for 12 buildings totaling 40,000 m² of floor space",
    issue_types: ["weak_verb", "no_metric"],
    feedback: "\"Helped with\" hides your role, and the line stops before the result.",
    suggested_rewrite:
      "Audited HVAC systems across 12 buildings (40,000 m²), flagging [N] issues that cut energy use by [X%]",
    needs_user_input: true,
  },
  {
    id: "lf_1",
    section: "experience",
    original_text: "Responsible for updating spreadsheets",
    issue_types: ["vague", "passive_voice"],
    feedback: "Duties read as passive. Say what the spreadsheets were for and who used them.",
    suggested_rewrite: "Maintained the energy-tracking spreadsheets the facilities team used for monthly reports",
    needs_user_input: false,
  },
  {
    id: "lf_2",
    section: "projects",
    original_text: "Designed a ½-scale wind turbine prototype in SolidWorks™",
    issue_types: ["no_metric"],
    feedback: "Strong project; add what the prototype achieved.",
    suggested_rewrite:
      "Designed a ½-scale wind turbine prototype in SolidWorks™ that produced [N] W in wind-tunnel tests",
    needs_user_input: true,
  },
  {
    id: "lf_3",
    section: "experience",
    original_text: "Worked on a team that reduced energy use",
    issue_types: ["vague"],
    feedback: "Name your part in the result.",
    suggested_rewrite: "Proposed lighting-schedule changes that helped the team reduce energy use",
    needs_user_input: false,
  },
  {
    id: "lf_4",
    section: "projects",
    original_text: "Logged ３５ wind-tunnel test runs",
    issue_types: ["irrelevant"],
    feedback: "Merge this into the turbine bullet so it supports a result.",
    suggested_rewrite: "Validated the design across 35 wind-tunnel test runs",
    needs_user_input: false,
  },
  {
    id: "lf_5",
    section: "skills",
    original_text: "SolidWorks™, MATLAB, Python, AutoCAD",
    issue_types: ["formatting"],
    feedback: "Group skills by type so recruiters scan them faster.",
    suggested_rewrite: "CAD: SolidWorks™, AutoCAD · Programming: MATLAB, Python",
    needs_user_input: false,
  },
  {
    id: "lf_6",
    section: "summary",
    original_text: "Mechanical engineering student seeking a summer internship.",
    issue_types: ["vague"],
    feedback: "Tie the objective to the kind of work you want.",
    suggested_rewrite:
      "Mechanical engineering student seeking a summer internship in sustainable building design",
    needs_user_input: false,
  },
];

export function sampleCritique(overrides: Partial<Critique> = {}): Critique {
  return {
    id: "c0ffee00-0000-4000-8000-000000000001",
    resume_id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-11-17T15:04:05.000Z",
    model: "claude-opus-5-5",
    prompt_version: "critique-v1",
    is_current: true,
    overall_score: 66,
    summary:
      "A solid technical foundation with relevant coursework and projects, held back by duty-focused bullets that rarely show results.",
    student_context: {
      stage: "late_student",
      note: "As a rising senior, one internship plus strong projects is typical; lead with outcomes.",
    },
    dimensions: [
      { dimension: "impact", score: 48, rationale: "Most bullets describe tasks, not outcomes.", top_fix: "Add a measurable result to your top three experience bullets." },
      { dimension: "clarity", score: 68, rationale: "Readable, but several lines open with weak verbs.", top_fix: "Start each bullet with a strong action verb." },
      { dimension: "relevance", score: 81, rationale: "Projects match the stated sustainable-design goal.", top_fix: "Move the wind-turbine project above coursework." },
      { dimension: "structure", score: 74, rationale: "Clear sections; skills could be grouped.", top_fix: "Group skills into CAD and programming." },
      { dimension: "ats_readability", score: 59, rationale: "Special characters and a two-column header may confuse parsers.", top_fix: "Use a single-column layout with standard section headings." },
    ],
    priorities: [
      { dimension: "impact", score: 48, top_fix: "Add a measurable result to your top three experience bullets." },
      { dimension: "ats_readability", score: 59, top_fix: "Use a single-column layout with standard section headings." },
      { dimension: "clarity", score: 68, top_fix: "Start each bullet with a strong action verb." },
    ],
    line_feedback: LINE_FEEDBACK,
    section_feedback: [{ section: "experience", feedback: "Lead with results." }],
    ats_issues: [
      { issue: "Contact details sit in a header text box.", fix: "Move your email and phone into the main body." },
      { issue: "Non-standard heading \"What I've built\".", fix: "Rename it to \"Projects\"." },
    ],
    missing_sections: ["Relevant coursework", "Certifications"],
    ...overrides,
  };
}
