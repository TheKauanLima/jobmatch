import { describe, expect, it } from "vitest";

import { JOB_CATEGORY_SLUGS, type JobCategory } from "@/lib/jobs/categories";
import { classifyJobCategory } from "@/lib/jobs/classifyCategory";

/**
 * Golden test for §7.8.3 (reviewer-blocking). `REAL_ROWS` are titles from
 * active `job_descriptions` rows on 2026-11-20 (pulled read-only). The
 * department is what the source board returned for that posting on the same
 * day (Greenhouse `departments[].name` joined " / "; Lever
 * `categories.department` + `categories.team`), or null for user-submitted
 * and legacy The Muse rows, which have none. Expected categories are hand
 * assigned.
 */
type Case = { title: string; department: string | null; expected: JobCategory };

const REAL_ROWS: Case[] = [
  // --- Greenhouse ---
  { title: "Screening & Transaction Monitoring Associate", department: "Legal", expected: "legal" },
  { title: "Software Engineer I, Backend (Continuous Delivery)", department: "Infrastructure Platform Eng", expected: "software" },
  { title: "Finance Associate", department: "Finance", expected: "finance" },
  { title: "Software Engineer, Intern  (Summer 2027)", department: "Engineering", expected: "software" },
  { title: "Startup Partnerships Associate", department: "Sales", expected: "sales-marketing" },
  { title: "PhD Machine Learning Software Engineer Intern (Summer 2027)", department: "Early Talent", expected: "data" },
  { title: "Associate, Strategic Finance & Investor Relations", department: "Accounting and Finance", expected: "finance" },
  { title: "Infrastructure Business Operations Associate", department: "Infrastructure", expected: "business-ops" },
  { title: "People Team Intern, HR Transformation (Winter 2027)", department: "University", expected: "people-hr" },
  { title: "Software Engineer Intern (2027) - Austin, TX", department: "University", expected: "software" },
  { title: "Acceleration Programs Intern", department: "Internships & Emerging Talent Positions", expected: "other" },
  { title: "Accounting Intern", department: "Internships & Emerging Talent Positions", expected: "finance" },
  { title: "Analytics Engineer Intern", department: "Internships & Emerging Talent Positions", expected: "data" },
  { title: "Broker Dealer Operations, Associate", department: "Institutional Sales, Trading, and Prime Services", expected: "finance" },
  { title: "Business Controller Intern", department: "Internships & Emerging Talent Positions", expected: "finance" },
  { title: "Compliance Investigations Associate", department: "Legal & Compliance", expected: "legal" },
  { title: "Credit Risk Intern", department: "Internships & Emerging Talent Positions", expected: "finance" },
  { title: "Employee and Workplace Experience Intern", department: "Internships & Emerging Talent Positions", expected: "people-hr" },
  { title: "Forward Deployed Engineer Intern (HR Technology)", department: "Internships & Emerging Talent Positions", expected: "software" },
  { title: "Master's University Grad Data Scientist (USA)", department: "University Engineering", expected: "data" },
  { title: "Master's Machine Learning Internship 2027 (USA)", department: "University", expected: "data" },
  { title: "Product Design Intern (USA)", department: "University Engineering", expected: "design" },
  { title: "Sales Analytics Intern 2027 (USA)", department: "University Sales", expected: "data" },
  { title: "Solutions Engineer Intern 2027 (USA)", department: "University Sales", expected: "sales-marketing" },
  { title: "Strategy & Operations Intern 2027 (USA)", department: "University Sales", expected: "business-ops" },
  { title: "University Grad Software Engineer 2027 (USA)", department: "University", expected: "software" },
  { title: "Content Enablement Intern 2027 (USA)", department: "University Sales", expected: "sales-marketing" },
  { title: "UX Quantitative Research Intern (USA)", department: "University Engineering", expected: "design" },
  { title: "Institutional Operations Intern", department: "Internships & Emerging Talent Positions", expected: "business-ops" },
  { title: "Internal Audit Intern", department: "Internships & Emerging Talent Positions", expected: "finance" },
  { title: "Machine Learning Engineer Intern", department: "Internships & Emerging Talent Positions", expected: "data" },
  { title: "Strategic Sourcing Intern", department: "Internships & Emerging Talent Positions", expected: "business-ops" },
  { title: "Tax Operations Intern", department: "Internships & Emerging Talent Positions", expected: "finance" },
  { title: "Payment Risk Intern", department: "Internships & Emerging Talent Positions", expected: "finance" },
  { title: "Policy Intern", department: "Internships & Emerging Talent Positions", expected: "legal" },
  { title: "Real Estate & Builds Intern", department: "Internships & Emerging Talent Positions", expected: "business-ops" },
  { title: "Sales Intern", department: "Internships & Emerging Talent Positions", expected: "sales-marketing" },
  { title: "Customer Success Associate (Portuguese Speaking)", department: "Commercial Customer Success", expected: "sales-marketing" },
  { title: "Research Science Intern (PhD)", department: "Engineering Interns", expected: "science" },
  { title: "Legal Operations Associate", department: "Commercial (Sub Team)", expected: "legal" },
  { title: "Data Engineer Intern (2027)", department: "Early Career", expected: "data" },
  { title: "Early Career, Inside Sales Representative (2027)", department: "Early Career", expected: "sales-marketing" },
  { title: "PhD Intern, AI Applied Scientist (2027)", department: "Early Career", expected: "data" },
  { title: "PhD Intern, Security Engineer (2027)", department: "Early Career", expected: "it-security" },
  { title: "PhD Intern, Software Engineer - Interaction Design (2027)", department: "Early Career", expected: "software" },
  { title: "Sales Associate - San Francisco/Los Angeles", department: "Ad Sales", expected: "sales-marketing" },
  { title: "Corporate Finance Intern (Summer 2027)", department: "Finance Division", expected: "finance" },
  { title: "Customer Experience Associate, Money", department: "Customer Care", expected: "business-ops" },
  { title: "Investment Analyst MBA Intern, Robinhood Ventures (Summer 2027)", department: "Robinhood Ventures", expected: "finance" },
  { title: "People Partner Intern (Summer 2027)", department: "PeopleX Division", expected: "people-hr" },
  { title: "AI Research Intern (PhD)", department: "University", expected: "data" },
  { title: "Product Designer, Thrive Intern", department: "University", expected: "design" },
  { title: "Applied Scientist Intern, PhD (Summer 2027)", department: "Early Talent", expected: "science" },
  { title: "Data Science Intern, Algorithms (Summer 2027 - SF/NYC)", department: "Early Talent", expected: "data" },
  { title: "Fleet Operations Associate (Overnight Shift)", department: "AV & Fleet Operations", expected: "business-ops" },
  { title: "2027 - AI and People Transformation Intern, NYC", department: "HR Operations", expected: "people-hr" },
  { title: "2027 - Finance Intern, San Francisco", department: "FP&A - P&T", expected: "finance" },
  { title: "2027 - Software Engineering Intern, AMER", department: "Intern", expected: "software" },
  { title: "Associate Commercial Growth Account Executive - Spanish Speaking", department: "Commercial Growth", expected: "sales-marketing" },
  { title: "Pricing & Monetization Associate", department: "Pricing and Packaging", expected: "business-ops" },
  { title: "Account Development Representative Intern - Atlanta", department: "Account Development Representative", expected: "sales-marketing" },
  { title: "Associate Sales Engineer, SE Desk - Mid West", department: "Sales Engineering", expected: "sales-marketing" },
  { title: "(New Grad) Account Development Representative II - Phoenix", department: "Account Development Representative", expected: "sales-marketing" },
  { title: "[2027] Associate Product Designer, Early Career", department: "Early Career Full-Time", expected: "design" },
  { title: "[2027] Data Scientist - PhD Early Career - Safety", department: "Early Career FT - PhD", expected: "data" },
  { title: "Business Operations Associate", department: "Business Operations (BizOps)", expected: "business-ops" },
  { title: "[Summer 2027] Software Engineer Intern", department: "Early Career Internship - Engineering", expected: "software" },
  { title: "Machine Learning Research Intern (Summer 2027)", department: "University", expected: "data" },
  { title: "Software Engineer, Public Sector - New Grad", department: "University", expected: "software" },
  { title: "Data Analyst, Intern", department: "5112 General University", expected: "data" },
  { title: "High School Internship, Software Engineering (Summer 2027)", department: "5112 General University", expected: "software" },
  { title: "Product Design Intern", department: "8811 Product Design", expected: "design" },
  { title: "Software Engineer, Early Career — Immediate Start", department: "5112 General University", expected: "software" },
  { title: "Software Dev Engineer I - Security Platform", department: "Platforms & Services", expected: "software" },
  { title: "Software Engineer I, Payments", department: "Community Growth ", expected: "software" },
  { title: "IT Engineer Intern (Early Careers Summer 2027)", department: "Information Security", expected: "it-security" },
  { title: "Fraud Strategy Associate", department: "Risk & Credit", expected: "business-ops" },
  { title: "Data Science Intern (2027 Start)", department: "University Recruiting - Engineering", expected: "data" },
  { title: "PhD GenAI Research Scientist Intern", department: "University Recruiting - Engineering", expected: "data" },
  { title: "Product Management Intern (Summer 2027)", department: "University Recruiting - Product", expected: "product" },
  { title: "Software Engineering Intern (BS/MS)", department: "Intern", expected: "software" },
  // --- Lever ---
  { title: "Deployment Strategist, New Grad - Intel, US Government", department: "Echo", expected: "business-ops" },
  { title: "Finance Operator Intern", department: "Finance", expected: "finance" },
  { title: "Forward Deployed Infrastructure Engineer, New Grad - US Government", department: "Delta", expected: "software" },
  { title: "Forward Deployed Software Engineer, Internship - Commercial", department: "Delta", expected: "software" },
  { title: "Contract Student Worker - Autonomy and Geofence Expansion (20 hrs/wk)", department: "Software / Autonomy Software", expected: "software" },
  { title: "Contract Student Worker - Data Scientist", department: "Zoox Internships / Fleet Operations", expected: "data" },
  { title: "Software Engineer, New Grad - Query Engines", department: "Dev", expected: "software" },
  { title: "Software Engineer, Internship - Sovereign AI Systems", department: "Dev", expected: "software" },
  { title: "Feature Integration Intern [Summer 2027]", department: "Zoox Internships / Product", expected: "other" },
  { title: "Hardware Engineer Intern, Manufacturing Operations [Summer 2027]", department: "Zoox Internships / Manufacturing Operations", expected: "hardware" },
  { title: "Hardware Engineer Intern, Vehicle Systems [Summer 2027]", department: "Zoox Internships / Advanced Hardware Engineering", expected: "hardware" },
  { title: "Industrial Design Intern [Summer 2027]", department: "Zoox Internships / Vehicle Development", expected: "design" },
  { title: "Information Technology & Applications Intern [Summer 2027]", department: "Zoox Internships / Information Technology", expected: "it-security" },
  { title: "Systems & Safety Engineering Intern [Summer 2027]", department: "Zoox Internships / System Design & Mission Assurance", expected: "hardware" },
  { title: "Contract Student Worker - Freeways Data Evaluation (20 hrs/wk)", department: "Zoox Internships / Software", expected: "software" },
  { title: "Contract Student Worker  – Firmware Engineer (FW Core System Services)", department: "Software / Software Platforms and Product", expected: "hardware" },
  { title: "Contract Student Worker – AI Validation and Benchmarking Engineer (40hrs / week Full-Time)", department: "Zoox Internships / Software", expected: "data" },
  { title: "Contract Student Worker Automation & Behavioral Science Engineer", department: "Software / Software Platforms and Product", expected: "software" },
  { title: "Logistics MRO Associate", department: "Manufacturing Operations / Logistics", expected: "business-ops" },
  { title: "Process Improvement Intern [Summer 2027]", department: "Zoox Internships / Fleet Operations", expected: "business-ops" },
  { title: "Service Designer Intern [Summer 2027]", department: "Zoox Internships / Product", expected: "design" },
  { title: "UX Designer Intern [Summer 2027]", department: "Zoox Internships / Product", expected: "design" },
  { title: "Information Security Engineer, Internship", department: "Information Security", expected: "it-security" },
  { title: "Privacy & Civil Liberties Engineer - New Grad", department: "Engineering", expected: "software" },
  { title: "Product Designer, New Grad - US Government", department: "Design", expected: "design" },
  // --- User-submitted and legacy The Muse rows (no department) ---
  { title: "Senior Frontend Engineer, Design Systems", department: null, expected: "software" },
  { title: "Summer 2027 Internship - Software Engineering - Florida", department: null, expected: "software" },
  { title: "Summer 2027 Cyber Security Internship", department: null, expected: "it-security" },
  { title: "Integrated Marketing & Promotion Manager Intern (TikTok Shop - Operations) - 2027 Summer", department: null, expected: "sales-marketing" },
  { title: "Supply Chain Planning Intern", department: null, expected: "business-ops" },
  { title: "Electrical Design Intern (Apodaca, N.L.)", department: null, expected: "hardware" },
  { title: "Field Service Intern", department: null, expected: "trades" },
  { title: "Corporate & Institutional Banking Undergraduate Intern - Commercial & Corporate Banking - Financials and Diversified Track", department: null, expected: "finance" },
  { title: "Mortgage Underwriter", department: null, expected: "finance" },
  { title: "Intern, R&D Undergraduate Summer - Design Engineering Mechanical Design, Onsite", department: null, expected: "hardware" },
  { title: "Intern, R&D Undergraduate Summer - TITANS Software, Onsite", department: null, expected: "software" },
  { title: "Intern, R&D Undergraduate Summer - Resilient Embedded Systems, Onsite", department: null, expected: "hardware" },
  { title: "Intern, R&D Undergraduate Summer - Advanced Radio Frequency and Electronic Systems, Onsite", department: null, expected: "hardware" },
  { title: "Intern, R&D Undergraduate Year-Round - Nanoscale Sciences, Onsite", department: null, expected: "science" },
  { title: "Intern, R&D Graduate Year Round - Photovoltaics & Materials Tech, Hybrid", department: null, expected: "hardware" },
  { title: "Intern, Information Technology", department: null, expected: "it-security" },
  { title: "Intern - Privacy", department: null, expected: "legal" },
  { title: "EH&S / HR Intern", department: null, expected: "people-hr" },
  { title: "Entry Level Lab Assistant - Cytogenetics/FISH Wet Lab", department: null, expected: "science" },
  { title: "Clinical Laboratory Technologist Trainee - Histology", department: null, expected: "healthcare" },
  { title: "Field Assessment Registered Nurse, Bronx, NY - $10,000 Sign-On Bonus (Spanish)", department: null, expected: "healthcare" },
  { title: "Phlebotomist - Float", department: null, expected: "healthcare" },
  { title: "Assistant Teachers at Vernon Hills KinderCare", department: null, expected: "other" },
  { title: "Customer Service Representative - Pittsburgh Airport", department: null, expected: "business-ops" },
  { title: "Member Service Representative (Full-Time) - Mililani", department: null, expected: "business-ops" },
  { title: "Entry Level Maintenance Technician", department: null, expected: "trades" },
  { title: "Journeyman Mechanical (Plumber)", department: null, expected: "trades" },
  { title: "Shop Foreperson", department: null, expected: "trades" },
  { title: "Junior Software Engineer", department: null, expected: "software" },
  { title: "Site Operations, Junior System Administrator", department: null, expected: "it-security" },
  { title: "Junior Information Security Officer", department: null, expected: "it-security" },
  { title: "Mortgage Loan Officer I", department: null, expected: "finance" },
  { title: "Starlink Aviation Production Technician (Entry Level, Temporary)", department: null, expected: "trades" },
  { title: "Business Development Associate (Early Career)", department: null, expected: "sales-marketing" },
  { title: "Machine Learning Engineer - Intern (TikTok BRIC) - 2027 Start (PhD)", department: null, expected: "data" },
  { title: "Social Media Intern, 2027 Summer U.S.", department: null, expected: "sales-marketing" },
  { title: "Summer 2027 Management Trainee Intern", department: null, expected: "business-ops" },
  { title: "Admin Intern", department: null, expected: "business-ops" },
  { title: "Loader Operator", department: null, expected: "trades" },
  { title: "Customer Assistance Representative - Klamath Falls, OR", department: null, expected: "business-ops" },
  { title: "Courier", department: null, expected: "other" },
  { title: "Junior Commissioning Engineer", department: null, expected: "hardware" },
  { title: "Junior Engineer - Tool Room", department: null, expected: "hardware" },
  { title: "Tendering Project Engineer Intern STP27", department: null, expected: "hardware" },
  { title: "Associate Technical Support Engineer (French Speaking)", department: null, expected: "it-security" },
  { title: "Retail (Store) Associate", department: null, expected: "sales-marketing" },
  { title: "Retail Store Associate Part Time Seasonal Winners - Grants Crossing", department: null, expected: "sales-marketing" },
  { title: "Retail Associate", department: null, expected: "sales-marketing" },
  { title: "RETAIL SALES ASSOCIATE FULL-TIME ZONE 2 SASKATOON MEADOWS MARKET", department: null, expected: "sales-marketing" },
  // QA 2026-11-20 regressions (live rows that were misclassified)
  { title: "Management Trainee - St. Cloud", department: null, expected: "business-ops" },
  { title: "Intern, R&D Graduate Summer -  Advanced RF Communications, Onsite", department: null, expected: "hardware" },
  { title: "IT Channel Marketing Intern - Europe STP27", department: null, expected: "sales-marketing" },
];

/** The tricky cases §7.8.3 names explicitly (some aren't on today's board). */
const NAMED_TRICKY_CASES: Case[] = [
  { title: "Internal Tools Engineer", department: null, expected: "software" },
  { title: "Product Designer", department: null, expected: "design" },
  { title: "Product Marketing Manager", department: null, expected: "sales-marketing" },
  { title: "Data Center Technician", department: null, expected: "it-security" },
  { title: "Software Engineering Apprentice", department: null, expected: "software" },
  { title: "Security Engineer", department: null, expected: "it-security" },
  { title: "Research Scientist, Machine Learning", department: null, expected: "data" },
  { title: "Mechanical Engineering Intern", department: null, expected: "hardware" },
  { title: "Embedded Software Engineer", department: null, expected: "hardware" },
  { title: "Recruiting Coordinator", department: null, expected: "people-hr" },
  { title: "Summer Intern", department: "Finance", expected: "finance" },
  { title: "Analyst", department: null, expected: "business-ops" },
];

const FIXTURE = [...REAL_ROWS, ...NAMED_TRICKY_CASES];

describe("classifyJobCategory golden fixture (§7.8.3)", () => {
  it("has at least 60 real rows", () => {
    expect(REAL_ROWS.length).toBeGreaterThanOrEqual(60);
  });

  it.each(FIXTURE)("$title / $department → $expected", ({ title, department, expected }) => {
    expect(classifyJobCategory({ title, department })).toBe(expected);
  });

  it("puts at most 10% of the fixture in 'other'", () => {
    const other = FIXTURE.filter((c) => c.expected === "other").length;
    expect(other / FIXTURE.length).toBeLessThanOrEqual(0.1);
    // The expectations are what's asserted above; also check the live output.
    const actualOther = FIXTURE.filter(
      (c) => classifyJobCategory({ title: c.title, department: c.department }) === "other",
    ).length;
    expect(actualOther / FIXTURE.length).toBeLessThanOrEqual(0.1);
  });

  it("only returns known slugs", () => {
    for (const c of FIXTURE) {
      expect(JOB_CATEGORY_SLUGS).toContain(classifyJobCategory(c));
    }
  });
});

describe("classifyJobCategory precedence", () => {
  it("keeps project/field/process engineer titles with a software or data signal out of hardware", () => {
    expect(classifyJobCategory({ title: "Field Engineer, Cloud Platform" })).toBe("software");
    expect(classifyJobCategory({ title: "Process Engineer, Data Pipelines" })).toBe("software");
    expect(classifyJobCategory({ title: "Quality Engineer" })).toBe("hardware");
  });

  it("prefers a specific title over the department", () => {
    expect(classifyJobCategory({ title: "Recruiting Coordinator", department: "Engineering / Finance" })).toBe("people-hr");
  });

  it("prefers the department over a generic title", () => {
    expect(classifyJobCategory({ title: "Associate", department: "Legal" })).toBe("legal");
    expect(classifyJobCategory({ title: "Analyst", department: "Finance" })).toBe("finance");
  });

  it("ignores hiring-program words in the department", () => {
    expect(classifyJobCategory({ title: "Summer Intern", department: "University Recruiting - Engineering" })).toBe("other");
  });

  it("matches the IT token only in uppercase", () => {
    expect(classifyJobCategory({ title: "IT Support Intern" })).toBe("it-security");
    expect(classifyJobCategory({ title: "Make it happen Intern" })).toBe("other");
  });

  it("falls back to other for an empty title", () => {
    expect(classifyJobCategory({ title: "" })).toBe("other");
    expect(classifyJobCategory({ title: "   ", department: null })).toBe("other");
  });
});
