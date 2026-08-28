import { describe, expect, it } from "vitest";

import {
  RESUME_MAX_FILE_SIZE_BYTES,
  resumeUploadFileSchema,
} from "@/lib/validation/schemas";

function makeFile(
  content: string | Uint8Array<ArrayBuffer>,
  name: string,
  type: string,
): File {
  return new File([content], name, { type });
}

describe("resumeUploadFileSchema", () => {
  it("accepts a valid PDF-typed file within the size cap", () => {
    const file = makeFile("hello", "resume.pdf", "application/pdf");
    const result = resumeUploadFileSchema.safeParse(file);
    expect(result.success).toBe(true);
  });

  it("accepts DOCX and plain text MIME types", () => {
    const docx = makeFile(
      "hello",
      "resume.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const txt = makeFile("hello", "resume.txt", "text/plain");

    expect(resumeUploadFileSchema.safeParse(docx).success).toBe(true);
    expect(resumeUploadFileSchema.safeParse(txt).success).toBe(true);
  });

  it("rejects a non-File value (e.g. a plain string field, or missing field)", () => {
    const result = resumeUploadFileSchema.safeParse("not-a-file");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/expected a file/i);
    }
  });

  it("rejects null (formData.get returns null when the field is absent)", () => {
    const result = resumeUploadFileSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects an empty file (0 bytes)", () => {
    const file = makeFile("", "empty.pdf", "application/pdf");
    const result = resumeUploadFileSchema.safeParse(file);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/empty/i);
    }
  });

  it("rejects a file over the 5MB cap", () => {
    const big = new Uint8Array(RESUME_MAX_FILE_SIZE_BYTES + 1);
    const file = makeFile(big, "huge.pdf", "application/pdf");
    const result = resumeUploadFileSchema.safeParse(file);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/exceeds/i);
    }
  });

  it("accepts a file exactly at the 5MB cap", () => {
    const exact = new Uint8Array(RESUME_MAX_FILE_SIZE_BYTES);
    const file = makeFile(exact, "exact.pdf", "application/pdf");
    const result = resumeUploadFileSchema.safeParse(file);
    expect(result.success).toBe(true);
  });

  it("rejects a disallowed MIME type (e.g. image/png)", () => {
    const file = makeFile("PNGDATA", "resume.png", "image/png");
    const result = resumeUploadFileSchema.safeParse(file);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/unsupported file type/i);
    }
  });

  it("rejects a malicious upload that spoofs a .pdf filename but has a disallowed/executable MIME type", () => {
    // A client could rename any file to resume.pdf; the API must key off the
    // MIME type (and, more robustly, real content sniffing — not tested at
    // this layer) rather than trusting the filename extension.
    const file = makeFile("MZ\x90\x00", "resume.pdf", "application/x-msdownload");
    const result = resumeUploadFileSchema.safeParse(file);
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string MIME type (some browsers/clients omit it)", () => {
    const file = makeFile("hello", "resume", "");
    const result = resumeUploadFileSchema.safeParse(file);
    expect(result.success).toBe(false);
  });
});
