import { describe, expect, it } from "vitest";

import {
  JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_TITLE_MAX_LENGTH,
  jobDescriptionCreateSchema,
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

describe("jobDescriptionCreateSchema", () => {
  it("accepts a minimal valid payload (title + description only)", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
      description: "Build things.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full payload including optional company and source_url", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
      company: "Acme",
      description: "Build things.",
      source_url: "https://example.com/jobs/1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing title", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      description: "Build things.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string title", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "",
      description: "Build things.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only title (trimmed before the min-length check)", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "   ",
      description: "Build things.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing description", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string description", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
      description: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed source_url", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
      description: "Build things.",
      source_url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string company when explicitly provided", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
      description: "Build things.",
      company: "",
    });
    expect(result.success).toBe(false);
  });

  it("allows company and source_url to be omitted entirely", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
      description: "Build things.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.company).toBeUndefined();
      expect(result.data.source_url).toBeUndefined();
    }
  });

  it("rejects a whitespace-only description (trimmed before the min-length check)", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
      description: "   \n\t  ",
    });
    expect(result.success).toBe(false);
  });

  // Fixed: title/description are now capped (see
  // JOB_DESCRIPTION_TITLE_MAX_LENGTH / JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH
  // in lib/validation/schemas.ts) since this text is fed whole into the
  // Claude matching prompt for every user who matches against it — a
  // cost/DoS and prompt-injection-surface concern, not just a storage one.
  it("rejects a title over the max length", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "A".repeat(JOB_DESCRIPTION_TITLE_MAX_LENGTH + 1),
      description: "Build things.",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at most/i);
    }
  });

  it("accepts a title exactly at the max length", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "A".repeat(JOB_DESCRIPTION_TITLE_MAX_LENGTH),
      description: "Build things.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a description over the max length", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
      description: "B".repeat(JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at most/i);
    }
  });

  it("accepts a description exactly at the max length", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
      description: "B".repeat(JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a hugely oversized title and description together (formerly accepted unbounded)", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "A".repeat(100_000),
      description: "B".repeat(500_000),
    });
    expect(result.success).toBe(false);
  });

  // Fixed: source_url is now restricted to http(s) schemes since it's
  // shared/public data expected to eventually render as a raw `<a href>` on
  // the frontend — a `javascript:` (or other non-http(s)) scheme is a
  // stored-XSS vector otherwise.
  it("rejects non-http(s) URL schemes for source_url (e.g. javascript:)", () => {
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
      description: "Build things.",
      source_url: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/http/i);
    }
  });

  it("rejects other non-http(s) schemes too (e.g. ftp, data, mailto)", () => {
    for (const url of [
      "ftp://example.com/job.pdf",
      "data:text/html,<script>alert(1)</script>",
      "mailto:jobs@example.com",
    ]) {
      const result = jobDescriptionCreateSchema.safeParse({
        title: "Software Engineer",
        description: "Build things.",
        source_url: url,
      });
      expect(result.success).toBe(false);
    }
  });

  it("still accepts http and https source_url values", () => {
    for (const url of [
      "https://example.com/jobs/1",
      "http://example.com/jobs/1",
    ]) {
      const result = jobDescriptionCreateSchema.safeParse({
        title: "Software Engineer",
        description: "Build things.",
        source_url: url,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects a source_url over the max length", () => {
    const hugePath = "a".repeat(2100);
    const result = jobDescriptionCreateSchema.safeParse({
      title: "Software Engineer",
      description: "Build things.",
      source_url: `https://example.com/${hugePath}`,
    });
    expect(result.success).toBe(false);
  });
});
