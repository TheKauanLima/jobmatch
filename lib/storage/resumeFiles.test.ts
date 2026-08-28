import { describe, expect, it, vi } from "vitest";

import {
  deleteResumeFile,
  extractResumeText,
  ResumeStorageError,
  ResumeTextExtractionError,
  RESUME_STORAGE_BUCKET,
  uploadResumeFile,
} from "@/lib/storage/resumeFiles";

function makeStorageClient(uploadResult: {
  error: unknown;
}) {
  const upload = vi.fn().mockResolvedValue(uploadResult);
  const remove = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn().mockReturnValue({ upload, remove });
  return {
    client: { storage: { from } } as never,
    upload,
    remove,
    from,
  };
}

describe("uploadResumeFile — storage path convention", () => {
  it("builds the path as {user_id}/{id}.{ext} with the correct extension per MIME type", async () => {
    const { client, upload, from } = makeStorageClient({ error: null });

    const { resumeId, storagePath } = await uploadResumeFile(client, {
      userId: "user-123",
      fileType: "application/pdf",
      buffer: Buffer.from("data"),
    });

    expect(from).toHaveBeenCalledWith(RESUME_STORAGE_BUCKET);
    expect(storagePath).toBe(`user-123/${resumeId}.pdf`);
    expect(upload).toHaveBeenCalledWith(
      storagePath,
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/pdf", upsert: false }),
    );
  });

  it("uses .docx for the DOCX MIME type and .txt for plain text", async () => {
    const { client: docxClient } = makeStorageClient({ error: null });
    const docx = await uploadResumeFile(docxClient, {
      userId: "u",
      fileType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("x"),
    });
    expect(docx.storagePath.endsWith(".docx")).toBe(true);

    const { client: txtClient } = makeStorageClient({ error: null });
    const txt = await uploadResumeFile(txtClient, {
      userId: "u",
      fileType: "text/plain",
      buffer: Buffer.from("x"),
    });
    expect(txt.storagePath.endsWith(".txt")).toBe(true);
  });

  it("generates a distinct id (and path) per call, never reusing one across uploads", async () => {
    const { client } = makeStorageClient({ error: null });
    const a = await uploadResumeFile(client, {
      userId: "u",
      fileType: "text/plain",
      buffer: Buffer.from("x"),
    });
    const b = await uploadResumeFile(client, {
      userId: "u",
      fileType: "text/plain",
      buffer: Buffer.from("x"),
    });
    expect(a.resumeId).not.toBe(b.resumeId);
    expect(a.storagePath).not.toBe(b.storagePath);
  });

  it("throws ResumeStorageError when the Storage upload fails", async () => {
    const { client } = makeStorageClient({
      error: { message: "bucket not found" },
    });

    await expect(
      uploadResumeFile(client, {
        userId: "u",
        fileType: "text/plain",
        buffer: Buffer.from("x"),
      }),
    ).rejects.toThrow(ResumeStorageError);
  });
});

describe("deleteResumeFile", () => {
  it("throws ResumeStorageError when the remove call fails", async () => {
    const remove = vi.fn().mockResolvedValue({ error: { message: "denied" } });
    const from = vi.fn().mockReturnValue({ remove });
    const client = { storage: { from } } as never;

    await expect(deleteResumeFile(client, "user/id.pdf")).rejects.toThrow(
      ResumeStorageError,
    );
  });

  it("resolves cleanly when the object is already gone (idempotent retry after a partial delete)", async () => {
    const remove = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ remove });
    const client = { storage: { from } } as never;

    await expect(
      deleteResumeFile(client, "user/id.pdf"),
    ).resolves.toBeUndefined();
  });
});

describe("extractResumeText", () => {
  it("reads plain text files directly and trims whitespace", async () => {
    const buffer = Buffer.from("  hello resume text  \n");
    const result = await extractResumeText("text/plain", buffer);
    expect(result).toBe("hello resume text");
  });

  it("returns an empty string for an empty .txt file (not an error)", async () => {
    const result = await extractResumeText("text/plain", Buffer.from(""));
    expect(result).toBe("");
  });

  it("throws ResumeTextExtractionError for a corrupt/unparseable PDF instead of crashing", async () => {
    const garbage = Buffer.from("this is not a real PDF file at all");
    await expect(extractResumeText("application/pdf", garbage)).rejects.toThrow(
      ResumeTextExtractionError,
    );
  });

  it("throws ResumeTextExtractionError for a corrupt/unparseable DOCX instead of crashing", async () => {
    const garbage = Buffer.from("this is not a real DOCX/zip file at all");
    await expect(
      extractResumeText(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        garbage,
      ),
    ).rejects.toThrow(ResumeTextExtractionError);
  });

  it("throws ResumeTextExtractionError for an unsupported MIME type that somehow slipped past validation", async () => {
    await expect(
      extractResumeText("image/png", Buffer.from("data")),
    ).rejects.toThrow(ResumeTextExtractionError);
  });
});
