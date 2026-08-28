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
