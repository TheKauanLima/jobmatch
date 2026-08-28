import { describe, expect, it, vi } from "vitest";

import {
  createResume,
  deleteResume,
  getResumeById,
  listResumesForUser,
  ResumeQueryError,
} from "@/lib/supabase/queries/resumes";

/**
 * Minimal chainable query-builder mock that mimics the subset of the
 * supabase-js fluent API these functions use (`.from().select().eq()...`).
 * Every chain method records its calls on `calls` so tests can assert on
 * *which* filters were applied — this is what verifies the "belt and
 * suspenders" ownership scoping described in docs/ARCHITECTURE.md §2: every
 * query must filter by `user_id` explicitly, not just rely on RLS.
 */
function makeQueryBuilder(resolvedValue: {
  data: unknown;
  error: unknown;
}) {
  const calls: { method: string; args: unknown[] }[] = [];

  const builder: Record<string, unknown> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ method: name, args });
      return builder;
    };

  builder.select = record("select");
  builder.insert = record("insert");
  builder.delete = record("delete");
  builder.eq = record("eq");
  builder.order = record("order");
  // Terminal methods resolve the "promise".
  builder.maybeSingle = vi.fn().mockResolvedValue(resolvedValue);
  builder.single = vi.fn().mockResolvedValue(resolvedValue);
  // `.order(...)` and bare `.eq(...)` chains (list/delete) are awaited
  // directly as thenables in supabase-js; emulate that by making the
  // builder itself thenable, resolving to `resolvedValue`.
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolvedValue).then(resolve);

  return { builder, calls };
}

function makeClient(builder: unknown) {
  return {
    from: vi.fn().mockReturnValue(builder),
  } as never;
}

describe("listResumesForUser", () => {
  it("scopes the query by user_id and orders by created_at desc", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], error: null });
    const client = makeClient(builder);

    await listResumesForUser(client, "user-1");

    expect(calls).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });
    expect(calls.some((c) => c.method === "order")).toBe(true);
  });

  it("returns [] when data is null", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    const result = await listResumesForUser(client, "user-1");
    expect(result).toEqual([]);
  });

  it("throws ResumeQueryError on a Postgres error", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { message: "connection reset" },
    });
    const client = makeClient(builder);

    await expect(listResumesForUser(client, "user-1")).rejects.toThrow(
      ResumeQueryError,
    );
  });
});

describe("getResumeById — privacy boundary", () => {
  it("filters by both id AND user_id (not id alone) so another user's id cannot be fetched by scoping only to the caller", async () => {
    const { builder, calls } = makeQueryBuilder({
      data: null,
      error: null,
    });
    const client = makeClient(builder);

    await getResumeById(client, "attacker-user", "victim-resume-id");

    expect(calls).toContainEqual({ method: "eq", args: ["id", "victim-resume-id"] });
    expect(calls).toContainEqual({ method: "eq", args: ["user_id", "attacker-user"] });
  });

  it("returns null (not an error) when the row belongs to someone else — caller turns this into 404, never leaking existence", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    const result = await getResumeById(client, "attacker-user", "victim-resume-id");
    expect(result).toBeNull();
  });

  it("throws ResumeQueryError on a Postgres error instead of silently returning a row", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { message: "boom" },
    });
    const client = makeClient(builder);

    await expect(getResumeById(client, "user-1", "some-id")).rejects.toThrow(
      ResumeQueryError,
    );
  });
});

describe("deleteResume — privacy boundary", () => {
  it("scopes the delete by both id AND user_id, so a crafted DELETE with another user's resume id cannot delete rows it doesn't own", async () => {
    const { builder, calls } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    await deleteResume(client, "attacker-user", "victim-resume-id");

    expect(calls).toContainEqual({ method: "eq", args: ["id", "victim-resume-id"] });
    expect(calls).toContainEqual({ method: "eq", args: ["user_id", "attacker-user"] });
  });

  it("throws ResumeQueryError on failure rather than silently succeeding", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      error: { message: "boom" },
    });
    const client = makeClient(builder);

    await expect(deleteResume(client, "user-1", "id-1")).rejects.toThrow(
      ResumeQueryError,
    );
  });
});

describe("createResume", () => {
  it("inserts with the caller-supplied user_id (never trusting a client-provided owner)", async () => {
    const row = {
      id: "resume-1",
      user_id: "user-1",
      storage_path: "user-1/resume-1.pdf",
      file_name: "resume.pdf",
      file_type: "application/pdf",
      file_size_bytes: 100,
      extracted_text: null,
      status: "uploaded",
      created_at: "now",
      updated_at: "now",
    };
    const { builder, calls } = makeQueryBuilder({ data: row, error: null });
    const client = makeClient(builder);

    const result = await createResume(client, {
      id: "resume-1",
      userId: "user-1",
      storagePath: "user-1/resume-1.pdf",
      fileName: "resume.pdf",
      fileType: "application/pdf",
      fileSizeBytes: 100,
      extractedText: null,
    });

    expect(result).toEqual(row);
    const insertCall = calls.find((c) => c.method === "insert");
    expect((insertCall?.args[0] as { user_id: string }).user_id).toBe(
      "user-1",
    );
  });

  it("throws ResumeQueryError when no row is returned", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    const client = makeClient(builder);

    await expect(
      createResume(client, {
        id: "resume-1",
        userId: "user-1",
        storagePath: "user-1/resume-1.pdf",
        fileName: "resume.pdf",
        fileType: "application/pdf",
        fileSizeBytes: 100,
        extractedText: null,
      }),
    ).rejects.toThrow(ResumeQueryError);
  });
});
