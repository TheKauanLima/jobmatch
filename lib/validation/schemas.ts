/**
 * zod schemas for API request bodies, per docs/ARCHITECTURE.md §3. Imported
 * by both route handlers (server-side parsing) and, eventually,
 * frontend-dev's forms (client-side validation) — single source of truth
 * for request shape.
 */

import { z } from "zod";

// ---------------------------------------------------------------------
// Resumes — POST /api/resumes
// ---------------------------------------------------------------------

/**
 * Accepted MIME types for resume uploads, per docs/ARCHITECTURE.md §5
 * (resolved decision): PDF, DOCX, and plain text.
 */
export const RESUME_ACCEPTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
] as const;

export type ResumeAcceptedMimeType =
  (typeof RESUME_ACCEPTED_MIME_TYPES)[number];

/** Max resume upload size, per docs/ARCHITECTURE.md §5: 5MB. */
export const RESUME_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

function isResumeAcceptedMimeType(
  value: string,
): value is ResumeAcceptedMimeType {
  return (RESUME_ACCEPTED_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Validates the `file` field of the `multipart/form-data` body for
 * `POST /api/resumes`. Node's global `File` (available in the Next.js
 * Route Handler runtime) is what `Request.formData()` yields for a file
 * field.
 */
export const resumeUploadFileSchema = z
  .instanceof(File, { message: "Expected a file upload." })
  .refine((file) => file.size > 0, {
    message: "File is empty.",
  })
  .refine((file) => file.size <= RESUME_MAX_FILE_SIZE_BYTES, {
    message: `File exceeds the ${
      RESUME_MAX_FILE_SIZE_BYTES / (1024 * 1024)
    }MB limit.`,
  })
  .refine((file) => isResumeAcceptedMimeType(file.type), {
    message:
      "Unsupported file type. Accepted types: PDF, DOCX, or plain text.",
  });

// ---------------------------------------------------------------------
// Job descriptions — POST /api/job-descriptions
// ---------------------------------------------------------------------

/**
 * Max lengths for job description text fields. `title`/`description` are
 * fed whole into the Claude matching prompt for every user who matches
 * against them (see docs/ARCHITECTURE.md §2, `/api/matches`, M5) — an
 * unbounded length is both a Claude cost/abuse concern (an attacker could
 * submit a multi-hundred-KB "job description" and force every future match
 * call against it to pay for those tokens) and a prompt-injection surface
 * that's cheaper to pad out with unbounded input. Caps chosen generously
 * for legitimate use, not tightly:
 * - `title`: 200 chars — comfortably covers even long real-world job titles
 *   ("Senior Staff Software Engineer, Platform Infrastructure (Remote,
 *   US)").
 * - `description`: 20,000 chars (~3,000-4,000 words) — comfortably covers
 *   even long real-world postings (base pay, benefits, multiple sections)
 *   while bounding per-match Claude token cost to a known ceiling.
 * - `company`: 200 chars — same order as `title`, no real company name
 *   approaches this.
 * - `source_url`: 2048 chars — the de facto max URL length supported by
 *   most browsers/servers.
 */
export const JOB_DESCRIPTION_TITLE_MAX_LENGTH = 200;
export const JOB_DESCRIPTION_COMPANY_MAX_LENGTH = 200;
export const JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH = 20_000;
export const JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH = 2048;

/** URL schemes accepted for `source_url`. */
const JOB_DESCRIPTION_ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

function isHttpOrHttpsUrl(value: string): boolean {
  try {
    return JOB_DESCRIPTION_ALLOWED_URL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Request body for submitting a job description, per
 * docs/ARCHITECTURE.md §2: `title` and `description` are required and must
 * be non-empty (not just present); `company` and `source_url` are optional.
 * `source_url` is validated as a well-formed URL restricted to `http`/
 * `https` schemes — this data is shared/public and `source_url` is expected
 * to eventually render as a plain `<a href>` on the frontend, so a
 * `javascript:`-or-similar scheme is rejected here rather than trusted to
 * the renderer to sanitize later.
 */
export const jobDescriptionCreateSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "title must not be empty.")
    .max(
      JOB_DESCRIPTION_TITLE_MAX_LENGTH,
      `title must be at most ${JOB_DESCRIPTION_TITLE_MAX_LENGTH} characters.`,
    ),
  company: z
    .string()
    .trim()
    .min(1, "company must not be empty when provided.")
    .max(
      JOB_DESCRIPTION_COMPANY_MAX_LENGTH,
      `company must be at most ${JOB_DESCRIPTION_COMPANY_MAX_LENGTH} characters.`,
    )
    .optional(),
  description: z
    .string()
    .trim()
    .min(1, "description must not be empty.")
    .max(
      JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
      `description must be at most ${JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH} characters.`,
    ),
  source_url: z
    .string()
    .trim()
    .max(
      JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH,
      `source_url must be at most ${JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH} characters.`,
    )
    .url("source_url must be a valid URL.")
    .refine(isHttpOrHttpsUrl, "source_url must use the http or https scheme.")
    .optional(),
});

export type JobDescriptionCreateInput = z.infer<
  typeof jobDescriptionCreateSchema
>;

// ---------------------------------------------------------------------
// Matches — POST /api/matches
// ---------------------------------------------------------------------

/**
 * Request body for `POST /api/matches`, per docs/ARCHITECTURE.md §2:
 * `{ resume_id, job_description_id }`. Both are validated as well-formed
 * uuids up front so a malformed id gets a clean `400` here rather than
 * surfacing as a raw Postgres "invalid input syntax for type uuid" error
 * further down the request-handling chain — the actual ownership/existence
 * checks (404s) happen in the route handler against the query layer.
 */
export const matchCreateSchema = z.object({
  resume_id: z.string().uuid("resume_id must be a valid id."),
  job_description_id: z.string().uuid("job_description_id must be a valid id."),
});

export type MatchCreateInput = z.infer<typeof matchCreateSchema>;
