/**
 * Storage + text-extraction module for resumes, per docs/ARCHITECTURE.md §3.
 * Owns:
 *   - upload/download/delete against the private `resumes` Storage bucket
 *     (created by supabase/migrations/0002_resumes_storage.sql)
 *   - the `{user_id}/{id}.{ext}` object path convention
 *   - text extraction (PDF via pdf-parse, DOCX via mammoth, plain read for
 *     .txt), per the resolved decision in docs/ARCHITECTURE.md §5.
 *
 * All functions take an already-authenticated (RLS-scoped) Supabase client
 * — never the admin/service-role client — so Storage RLS policies
 * (`supabase/migrations/0002_resumes_storage.sql`) apply exactly as they
 * would for any other authenticated request.
 *
 * IMPORTANT: nothing in this module logs resume file contents or extracted
 * text. Errors are logged with messages only (see callers in
 * app/api/resumes/**).
 */

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

import type { Database } from "@/types/database";
import type { ResumeAcceptedMimeType } from "@/lib/validation/schemas";

export const RESUME_STORAGE_BUCKET = "resumes";

/** Thrown when a Storage operation (upload/download/delete) fails. */
export class ResumeStorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ResumeStorageError";
  }
}

/**
 * Thrown when text extraction fails (corrupt/unparseable file, or an
 * unsupported MIME type slipping past validation). Callers decide whether
 * this is fatal — at upload time (`POST /api/resumes`) it is not: the
 * resume row is still created with `extracted_text = null`.
 */
export class ResumeTextExtractionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ResumeTextExtractionError";
  }
}

const EXTENSION_BY_MIME_TYPE: Record<ResumeAcceptedMimeType, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "text/plain": "txt",
};

function extensionForMimeType(fileType: string): string {
  return EXTENSION_BY_MIME_TYPE[fileType as ResumeAcceptedMimeType] ?? "bin";
}

type Client = SupabaseClient<Database>;

/**
 * Uploads a resume file's bytes to the private `resumes` bucket, generating
 * the resume's `id` up front so the object path
 * (`{user_id}/{id}.{ext}`) can be constructed before the corresponding
 * `resumes` row exists. The caller (route handler) uses the returned
 * `resumeId` as the explicit primary key when inserting that row via
 * `lib/supabase/queries/resumes.ts#createResume`.
 */
export async function uploadResumeFile(
  supabase: Client,
  params: { userId: string; fileType: string; buffer: Buffer },
): Promise<{ resumeId: string; storagePath: string }> {
  const resumeId = randomUUID();
  const ext = extensionForMimeType(params.fileType);
  const storagePath = `${params.userId}/${resumeId}.${ext}`;

  const { error } = await supabase.storage
    .from(RESUME_STORAGE_BUCKET)
    .upload(storagePath, params.buffer, {
      contentType: params.fileType,
      upsert: false,
    });

  if (error) {
    throw new ResumeStorageError(
      `Failed to upload resume file to Storage: ${error.message}`,
      error,
    );
  }

  return { resumeId, storagePath };
}

/**
 * Downloads a resume file's raw bytes from Storage. Not used by the M2
 * upload/list/detail/delete flow, but part of this module's ownership of
 * the bucket per docs/ARCHITECTURE.md §3 — used by future re-extraction
 * (e.g. `POST /api/resumes/:id/analyze` falling back to the stored file
 * when `extracted_text` is null).
 */
export async function downloadResumeFile(
  supabase: Client,
  storagePath: string,
): Promise<Buffer> {
  const { data, error } = await supabase.storage
    .from(RESUME_STORAGE_BUCKET)
    .download(storagePath);

  if (error || !data) {
    throw new ResumeStorageError(
      `Failed to download resume file from Storage: ${
        error?.message ?? "no data returned"
      }`,
      error,
    );
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Deletes a resume file's Storage object. */
export async function deleteResumeFile(
  supabase: Client,
  storagePath: string,
): Promise<void> {
  const { error } = await supabase.storage
    .from(RESUME_STORAGE_BUCKET)
    .remove([storagePath]);

  if (error) {
    throw new ResumeStorageError(
      `Failed to delete resume file from Storage: ${error.message}`,
      error,
    );
  }
}

/**
 * Extracts plain text from a resume file's bytes, dispatching on MIME type.
 * Throws `ResumeTextExtractionError` on failure (corrupt file, unsupported
 * type) — the caller decides how to handle that (see module docstring).
 */
export async function extractResumeText(
  fileType: string,
  buffer: Buffer,
): Promise<string> {
  switch (fileType) {
    case "application/pdf":
      return extractPdfText(buffer);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractDocxText(buffer);
    case "text/plain":
      return buffer.toString("utf-8").trim();
    default:
      throw new ResumeTextExtractionError(
        `Unsupported file type for text extraction: ${fileType}`,
      );
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text.trim();
  } catch (err) {
    throw new ResumeTextExtractionError(
      "Failed to extract text from PDF.",
      err,
    );
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  } catch (err) {
    throw new ResumeTextExtractionError(
      "Failed to extract text from DOCX.",
      err,
    );
  }
}
