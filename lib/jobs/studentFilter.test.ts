import { describe, expect, it } from "vitest";

import { isStudentRelevantTitle, SENIOR_TITLE_PATTERN, STUDENT_TITLE_PATTERN } from "@/lib/jobs/studentFilter";

const strict = { includeUnlabeledTitles: false };
const lenient = { includeUnlabeledTitles: true };

describe("isStudentRelevantTitle (§13.6.3)", () => {
  it.each([
    "Software Engineering Intern",
    "Summer Internship - Data",
    "Co-op: Mechanical Engineering",
    "Coop Student, Finance",
    "New Grad Software Engineer",
    "New Graduate Analyst",
    "Graduate Program - Operations",
    "Entry-Level Accountant",
    "Entry Level Accountant",
    "Junior Developer",
    "Jr. Data Analyst",
    "Jr Data Analyst",
    "Associate Product Designer",
    "Apprentice Electrician",
    "Policy Fellowship",
    "Early Career Researcher",
    "University Recruiting - SWE",
    "Campus Hire: Analyst",
    "Student Researcher",
    "Management Trainee",
    "Analyst I",
    "Engineer I, Platform",
    "Support Engineer Level 1",
    "INTERN, MARKETING",
  ])("keeps %j", (title) => {
    expect(isStudentRelevantTitle(title, strict)).toBe(true);
  });

  it.each([
    "Senior Associate",
    "Sr. Software Engineer",
    "Sr Analyst, New Grad Program",
    "Staff Engineer",
    "Principal Data Scientist",
    "Lead Intern Coordinator",
    "Engineering Manager",
    "Director of Campus Recruiting",
    "Head of Student Success",
    "VP, Associate Relations",
    "Vice President - Internships",
    "Chief of Staff",
    "Solutions Architect (Junior)",
    "Distinguished Engineer",
  ])("drops %j (senior wins even when a student term matches)", (title) => {
    expect(isStudentRelevantTitle(title, strict)).toBe(false);
    expect(isStudentRelevantTitle(title, lenient)).toBe(false);
  });

  it.each(["Software Engineer", "Data Analyst", "Analyst II", "Engineer III", "Support Engineer Level 10", "Internal Auditor", "Leader in Training", "Studentship Officer"])(
    "treats %j as unlabeled: dropped by default, kept with include_unlabeled_titles",
    (title) => {
      expect(isStudentRelevantTitle(title, strict)).toBe(false);
      expect(isStudentRelevantTitle(title, lenient)).toBe(true);
    },
  );

  it("uses letter/digit boundaries, not substrings", () => {
    expect(STUDENT_TITLE_PATTERN.test("International Sales")).toBe(false);
    expect(SENIOR_TITLE_PATTERN.test("Misleading Title")).toBe(false);
    expect(SENIOR_TITLE_PATTERN.test("Leadership Program")).toBe(false);
    expect(STUDENT_TITLE_PATTERN.test("Analyst I")).toBe(true);
    expect(STUDENT_TITLE_PATTERN.test("Analyst Ii")).toBe(false);
  });

  it("normalizes full-width characters before matching", () => {
    expect(isStudentRelevantTitle("Ｉｎｔｅｒｎ", strict)).toBe(true);
    expect(isStudentRelevantTitle("Ｓｅｎｉｏｒ Intern", strict)).toBe(false);
  });
});
