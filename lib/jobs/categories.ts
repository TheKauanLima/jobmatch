/**
 * The fixed job-board "Field" list (docs/ARCHITECTURE.md §7.8.3). One
 * category per job, assigned by `lib/jobs/classifyCategory.ts`. List order is
 * the display order. Changing the list needs a migration (the
 * `job_descriptions_job_category_check` constraint) and a §13.3.4 update,
 * because these slugs are also the M2.1 role-family group vocabulary.
 *
 * NO IMPORTS: the client bundle imports this file for the Field select and
 * the field tag on job cards.
 */

export const JOB_CATEGORIES = [
  { slug: "software", label: "Software Engineering" },
  { slug: "data", label: "Data & AI" },
  { slug: "it-security", label: "IT & Security" },
  { slug: "hardware", label: "Hardware & Physical Engineering" },
  { slug: "product", label: "Product Management" },
  { slug: "design", label: "Design" },
  { slug: "science", label: "Science & Research" },
  { slug: "finance", label: "Finance & Accounting" },
  { slug: "business-ops", label: "Business & Operations" },
  { slug: "sales-marketing", label: "Sales & Marketing" },
  { slug: "people-hr", label: "People & HR" },
  { slug: "legal", label: "Legal & Policy" },
  { slug: "healthcare", label: "Healthcare" },
  { slug: "trades", label: "Skilled Trades & Construction" },
  { slug: "other", label: "Other" },
] as const;

export type JobCategory = (typeof JOB_CATEGORIES)[number]["slug"];

export const JOB_CATEGORY_SLUGS: readonly JobCategory[] = JOB_CATEGORIES.map(
  (category) => category.slug,
);

export function isJobCategory(value: string): value is JobCategory {
  return (JOB_CATEGORY_SLUGS as readonly string[]).includes(value);
}

/** Display label for a slug ("data" → "Data & AI"), or null for null/unknown values. */
export function jobCategoryLabel(slug: string | null): string | null {
  if (slug === null) return null;
  return JOB_CATEGORIES.find((category) => category.slug === slug)?.label ?? null;
}
