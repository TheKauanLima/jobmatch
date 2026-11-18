import {
  deriveCritiquePriorities,
  type Critique,
  type CritiqueDimension,
} from "@/types/domain";

/**
 * A static, entirely FICTIONAL resume critique for the landing page's
 * "See what you get" showcase (app/page.tsx). It is rendered through the
 * real `CritiqueSection`, so it is typed as the real `Critique` and keeps
 * the same invariants as API data: five dimensions in
 * `CRITIQUE_DIMENSION_ORDER`, scores 0..100, and `priorities` derived with
 * `deriveCritiquePriorities` (never hand-written).
 *
 * No real person, school or employer is named or implied. Nothing here was
 * produced from a user's resume, and nothing is sent anywhere: this module
 * is plain data with no API, Claude or database access.
 *
 * Showcase shape (keep it when editing): an engineering student, overall
 * score in the 60s, all three score bands across the dimensions, three
 * priorities, line feedback across several sections with exactly one
 * `[placeholder]` rewrite first in the list (so the trimmed preview shows
 * "Needs your numbers"), plus ATS issues and missing sections.
 */

const SAMPLE_DIMENSIONS: CritiqueDimension[] = [
  {
    dimension: "impact",
    score: 46,
    rationale:
      "Most bullets list duties (\"responsible for\", \"worked on\") rather than results, and only one line includes a number.",
    top_fix:
      "Add a measurable result to your internship bullets: tests written, bugs caught, time saved or coverage gained.",
  },
  {
    dimension: "clarity",
    score: 71,
    rationale:
      "Bullets are easy to scan, but a few are vague (\"backend stuff\") or run to three lines.",
    top_fix: "Replace vague phrases with the specific tool, system or task, and keep each bullet to one or two lines.",
  },
  {
    dimension: "relevance",
    score: 82,
    rationale:
      "Coursework, the robotics project and the internship all line up well with embedded and software internships.",
    top_fix: "Move the robotics project above the part-time retail job so the most relevant work is read first.",
  },
  {
    dimension: "structure",
    score: 64,
    rationale:
      "Sections are in a sensible order, but the skills list mixes languages with soft skills and there is no Links line.",
    top_fix:
      "Split Skills into labelled groups (Languages, Tools) and add a Links line with your GitHub or portfolio.",
  },
  {
    dimension: "ats_readability",
    score: 57,
    rationale:
      "The two-column layout and the contact details placed in the page header can be read out of order by applicant tracking systems.",
    top_fix: "Switch to a single-column layout and move your email and phone into the body of the page.",
  },
];

export const SAMPLE_CRITIQUE: Critique = {
  id: "sample-critique",
  resume_id: "sample-resume",
  created_at: "2026-11-01T12:00:00.000Z",
  model: "claude-opus-5-5",
  prompt_version: "critique-v1",
  is_current: true,
  overall_score: 64,
  summary:
    "A solid base for an embedded or software internship: relevant coursework, a hands-on robotics project and a technical internship. The biggest gap is impact: most bullets describe duties instead of results, and the two-column layout may confuse applicant tracking systems. Working through the three priorities below should lift this resume into the Strong band.",
  student_context: {
    stage: "late_student",
    note: "Scored as a third-year computer engineering student applying for internships. Limited work experience is expected at this stage, so projects and coursework carry more weight.",
  },
  dimensions: SAMPLE_DIMENSIONS,
  priorities: deriveCritiquePriorities(SAMPLE_DIMENSIONS),
  line_feedback: [
    {
      id: "sample_lf_0",
      section: "experience",
      original_text: "Responsible for helping with the testing of the warehouse inventory app.",
      issue_types: ["weak_verb", "passive_voice", "no_metric"],
      feedback:
        "\"Responsible for helping with\" hides what you actually did. Lead with your action and show the result of your testing.",
      suggested_rewrite:
        "Wrote [number] automated tests for a warehouse inventory app, raising test coverage from [X]% to [Y]% and catching [number] bugs before release.",
      needs_user_input: true,
    },
    {
      id: "sample_lf_1",
      section: "experience",
      original_text: "Worked on backend stuff using Python and SQL for the data team.",
      issue_types: ["vague", "weak_verb"],
      feedback:
        "\"Backend stuff\" gives a recruiter nothing to picture. Name what you built and who used it.",
      suggested_rewrite:
        "Built Python scripts that load nightly sales data into the data team's SQL database for reporting.",
      needs_user_input: false,
    },
    {
      id: "sample_lf_2",
      section: "projects",
      original_text:
        "Line-following robot - made a robot that follows lines using sensors and a microcontroller, worked with a team of 4 people over the semester and we got 2nd place in the competition at the end.",
      issue_types: ["too_long", "weak_verb"],
      feedback:
        "Good project, buried in a long sentence. Put the technical work first and the result at the end.",
      suggested_rewrite:
        "Co-designed a line-following robot in a team of 4, using infrared sensors and PID control on a microcontroller; placed 2nd in the end-of-semester course competition.",
      needs_user_input: false,
    },
    {
      id: "sample_lf_3",
      section: "skills",
      original_text: "Skills: Microsoft Office, Python, teamwork, C, hard worker, Java, HTML",
      issue_types: ["irrelevant", "formatting"],
      feedback:
        "Soft skills like \"hard worker\" are better shown through your bullets than listed. Group the technical skills so they are quick to scan.",
      suggested_rewrite: "Languages: Python, C, Java, HTML",
      needs_user_input: false,
    },
    {
      id: "sample_lf_4",
      section: "education",
      original_text: "Dean's list 2 semesters. Relevent coursework: Data Structures, Embeded Systems, Digital Logic",
      issue_types: ["typo_grammar"],
      feedback: "Two spelling mistakes in a short line. Typos stand out on an engineering resume.",
      suggested_rewrite:
        "Dean's List (2 semesters). Relevant coursework: Data Structures, Embedded Systems, Digital Logic",
      needs_user_input: false,
    },
  ],
  // Not displayed in V1 (§13.20.6); kept empty.
  section_feedback: [],
  ats_issues: [
    {
      issue: "Two-column layout with skills in a sidebar text box.",
      fix: "Use a single column. Many applicant tracking systems read text boxes out of order or skip them.",
    },
    {
      issue: "Email and phone number are in the page header.",
      fix: "Move them into the body of the page; some systems ignore headers and footers.",
    },
  ],
  missing_sections: ["Links (GitHub or portfolio)", "Technical summary"],
};

/** How many line-feedback items the landing page shows before the sign-up note. */
export const SAMPLE_LINE_FEEDBACK_PREVIEW_COUNT = 3;
