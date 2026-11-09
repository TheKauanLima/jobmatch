import { describe, expect, it } from "vitest";

import {
  purgeUserResumeObjects,
  STORAGE_PURGE_MAX_DEPTH,
  STORAGE_PURGE_MAX_ROUNDS,
  STORAGE_PURGE_PAGE_SIZE,
  StoragePurgeError,
} from "@/lib/account/purgeUserStorage";
import {
  createFakeStorage,
  resumePaths,
  USER_A,
  USER_B,
} from "@/tests/fakes/supabaseStorage";
import { RESUME_STORAGE_BUCKET } from "@/lib/storage/resumeFiles";

function adminWith(storage: ReturnType<typeof createFakeStorage>["storage"]) {
  return { storage } as never;
}

describe("purgeUserResumeObjects — completeness", () => {
  it("removes every object under {user_id}/ across multiple pages (does not assume one page)", async () => {
    const fake = createFakeStorage(resumePaths(USER_A, 250));

    const result = await purgeUserResumeObjects(adminWith(fake.storage), USER_A);

    expect(result.removed).toBe(250);
    expect(fake.objects.size).toBe(0);
    // 3 non-empty pages + 1 final empty list.
    expect(fake.calls.remove).toHaveLength(3);
    expect(fake.calls.list).toHaveLength(4);
    expect(fake.calls.from.every((b) => b === RESUME_STORAGE_BUCKET)).toBe(true);
  });

  it("lists 100 at a time, always from offset 0 (removed objects drop out of the listing)", async () => {
    const fake = createFakeStorage(resumePaths(USER_A, 150));

    await purgeUserResumeObjects(adminWith(fake.storage), USER_A);

    for (const call of fake.calls.list) {
      expect(call.prefix).toBe(USER_A);
      expect(call.limit).toBe(STORAGE_PURGE_PAGE_SIZE);
      expect(call.offset).toBe(0);
    }
    for (const batch of fake.calls.remove) {
      expect(batch.length).toBeLessThanOrEqual(STORAGE_PURGE_PAGE_SIZE);
    }
  });

  it("recurses into nested folders under the user's prefix", async () => {
    const fake = createFakeStorage([
      `${USER_A}/top.pdf`,
      `${USER_A}/a/one.pdf`,
      `${USER_A}/a/b/two.pdf`,
      `${USER_A}/a/b/.emptyFolderPlaceholder`,
      ...resumePaths(`${USER_A}/many`, 120),
    ]);

    const result = await purgeUserResumeObjects(adminWith(fake.storage), USER_A);

    expect(fake.objects.size).toBe(0);
    expect(result.removed).toBe(124);
  });

  it("handles a full page of 100 entries that are all folders (the folders-only branch), then continues to the files after them", async () => {
    // Folder names sort before the top-level files, so the first page of the
    // listing is exactly 100 folders and no files.
    const folderFiles = Array.from(
      { length: STORAGE_PURGE_PAGE_SIZE },
      (_, i) => `${USER_A}/a${String(i).padStart(3, "0")}/file.pdf`,
    );
    const topFiles = [`${USER_A}/z-1.pdf`, `${USER_A}/z-2.pdf`];
    const fake = createFakeStorage([...folderFiles, ...topFiles]);

    const firstPage = await fake.storage
      .from(RESUME_STORAGE_BUCKET)
      .list(USER_A, { limit: STORAGE_PURGE_PAGE_SIZE, offset: 0 });
    expect(firstPage.data).toHaveLength(STORAGE_PURGE_PAGE_SIZE);
    expect(firstPage.data!.every((e) => e.id === null)).toBe(true);
    fake.calls.list.length = 0;

    // 100 folders cost ~3 rounds each, which is (correctly) over the
    // production per-attempt time budget — see the next test. Lift the cap
    // here to exercise the branch itself.
    const result = await purgeUserResumeObjects(
      adminWith(fake.storage),
      USER_A,
      { maxRounds: 1000 },
    );

    expect(fake.objects.size).toBe(0);
    expect(result.removed).toBe(STORAGE_PURGE_PAGE_SIZE + topFiles.length);
    // No remove call ever contained a folder name as if it were a file.
    for (const batch of fake.calls.remove) {
      for (const path of batch) {
        expect(path.endsWith(".pdf")).toBe(true);
      }
    }
  });

  it("many folders over the per-attempt round cap: first attempt throws, retries converge to fully purged", async () => {
    const folderFiles = Array.from(
      { length: STORAGE_PURGE_PAGE_SIZE },
      (_, i) => `${USER_A}/a${String(i).padStart(3, "0")}/file.pdf`,
    );
    const fake = createFakeStorage(folderFiles);

    await expect(
      purgeUserResumeObjects(adminWith(fake.storage), USER_A),
    ).rejects.toBeInstanceOf(StoragePurgeError);
    const afterFirst = fake.objects.size;
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(folderFiles.length);

    let attempts = 1;
    while (fake.objects.size > 0 && attempts < 20) {
      attempts += 1;
      await purgeUserResumeObjects(adminWith(fake.storage), USER_A).catch(
        () => undefined,
      );
    }
    expect(fake.objects.size).toBe(0);
  });

  it("never touches another user's objects", async () => {
    const other = resumePaths(USER_B, 5);
    const fake = createFakeStorage([...resumePaths(USER_A, 5), ...other]);

    await purgeUserResumeObjects(adminWith(fake.storage), USER_A);

    expect([...fake.objects].sort()).toEqual([...other].sort());
    for (const batch of fake.calls.remove) {
      for (const path of batch) {
        expect(path.startsWith(`${USER_A}/`)).toBe(true);
      }
    }
  });

  it("also leaves alone a sibling prefix that merely starts with the user id", async () => {
    const lookalike = `${USER_A}-evil/file.pdf`;
    const fake = createFakeStorage([`${USER_A}/mine.pdf`, lookalike]);

    await purgeUserResumeObjects(adminWith(fake.storage), USER_A);

    expect([...fake.objects]).toEqual([lookalike]);
  });

  it("is a clean no-op (0 removed) when nothing is left — the idempotent re-run case", async () => {
    const fake = createFakeStorage([]);

    const result = await purgeUserResumeObjects(adminWith(fake.storage), USER_A);

    expect(result.removed).toBe(0);
    expect(fake.calls.remove).toHaveLength(0);
    expect(fake.calls.list).toHaveLength(1);
  });
});

describe("purgeUserResumeObjects — safety rails", () => {
  it.each([
    ["empty string", ""],
    ["non-uuid", "not-a-uuid"],
    ["path traversal", "../11111111-1111-4111-8111-111111111111"],
    ["uuid with trailing slash", `${USER_A}/`],
    ["uuid with subpath", `${USER_A}/x`],
  ])(
    "refuses a %s user id without making any Storage call (an empty prefix would be the whole bucket)",
    async (_label, badId) => {
      const fake = createFakeStorage([
        ...resumePaths(USER_A, 3),
        ...resumePaths(USER_B, 3),
      ]);

      await expect(
        purgeUserResumeObjects(adminWith(fake.storage), badId),
      ).rejects.toBeInstanceOf(StoragePurgeError);

      expect(fake.calls.list).toHaveLength(0);
      expect(fake.calls.remove).toHaveLength(0);
      expect(fake.objects.size).toBe(6);
    },
  );

  it("throws instead of looping forever when remove() reports success but deletes nothing (genuinely stuck)", async () => {
    const fake = createFakeStorage(resumePaths(USER_A, 3), {
      removeIsNoop: true,
    });

    await expect(
      purgeUserResumeObjects(adminWith(fake.storage), USER_A),
    ).rejects.toThrow(/no progress/);
    expect(fake.calls.remove).toHaveLength(1);
    // Initial list + exactly one confirming re-list.
    expect(fake.calls.list).toHaveLength(2);
    expect(fake.objects.size).toBe(3);
  });

  it("does NOT trip the no-progress guard when a concurrent request removed the same objects between list and remove", async () => {
    // Simulates another tab's DELETE /api/resumes/:id (or a double-submitted
    // DELETE /api/account) winning the race: by the time our remove() runs,
    // the objects are already gone, so remove() returns data: [].
    const fake = createFakeStorage(resumePaths(USER_A, 3), {
      beforeRemove: (n, paths, objects) => {
        if (n === 1) for (const p of paths) objects.delete(p);
      },
    });

    const result = await purgeUserResumeObjects(
      adminWith(fake.storage),
      USER_A,
    );

    expect(fake.objects.size).toBe(0);
    // Nothing was removed by *this* call; the concurrent request did it.
    expect(result.removed).toBe(0);
  });

  it("after a concurrent partial removal, keeps going and removes whatever is left", async () => {
    // The concurrent request removes the first page; more objects remain
    // beyond it, which this purge must still delete.
    const fake = createFakeStorage(resumePaths(USER_A, 150), {
      beforeRemove: (n, paths, objects) => {
        if (n === 1) for (const p of paths) objects.delete(p);
      },
    });

    const result = await purgeUserResumeObjects(
      adminWith(fake.storage),
      USER_A,
    );

    expect(fake.objects.size).toBe(0);
    expect(result.removed).toBe(50);
  });

  it("enforces the round cap (shared across the whole purge) and throws rather than running past the time budget", async () => {
    // One more full page than the cap allows.
    const fake = createFakeStorage(
      resumePaths(USER_A, STORAGE_PURGE_MAX_ROUNDS * STORAGE_PURGE_PAGE_SIZE + 1),
    );

    await expect(
      purgeUserResumeObjects(adminWith(fake.storage), USER_A),
    ).rejects.toThrow(/maximum number of list\/remove rounds/);
    expect(fake.calls.list).toHaveLength(STORAGE_PURGE_MAX_ROUNDS);
    expect(fake.objects.size).toBe(1);
  });

  it("the round cap fits the 60s route budget at a pessimistic ~250ms per Storage request (≤3 requests per round)", () => {
    expect(STORAGE_PURGE_MAX_ROUNDS * 3 * 0.25).toBeLessThan(45);
  });

  it("refuses folder nesting deeper than the supported depth", async () => {
    const deep = `${USER_A}/${Array.from(
      { length: STORAGE_PURGE_MAX_DEPTH + 2 },
      (_, i) => `d${i}`,
    ).join("/")}/file.pdf`;
    const fake = createFakeStorage([deep]);

    await expect(
      purgeUserResumeObjects(adminWith(fake.storage), USER_A),
    ).rejects.toThrow(/depth/);
  });
});

describe("purgeUserResumeObjects — failures are retryable", () => {
  it("throws StoragePurgeError on a list error", async () => {
    const fake = createFakeStorage(resumePaths(USER_A, 3), {
      failList: () => true,
    });

    await expect(
      purgeUserResumeObjects(adminWith(fake.storage), USER_A),
    ).rejects.toBeInstanceOf(StoragePurgeError);
    expect(fake.objects.size).toBe(3);
  });

  it("stops at the first remove error, and a re-run finishes the remaining objects", async () => {
    let failSecondRemove = true;
    const fake = createFakeStorage(resumePaths(USER_A, 250), {
      failRemove: (n) => failSecondRemove && n === 2,
    });

    await expect(
      purgeUserResumeObjects(adminWith(fake.storage), USER_A),
    ).rejects.toBeInstanceOf(StoragePurgeError);
    // First page removed, the rest still present.
    expect(fake.objects.size).toBe(150);

    failSecondRemove = false;
    const retry = await purgeUserResumeObjects(adminWith(fake.storage), USER_A);

    expect(retry.removed).toBe(150);
    expect(fake.objects.size).toBe(0);
  });

  it("error messages never include object paths", async () => {
    const fake = createFakeStorage(resumePaths(USER_A, 2), {
      failRemove: () => true,
    });

    const err = await purgeUserResumeObjects(
      adminWith(fake.storage),
      USER_A,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StoragePurgeError);
    expect((err as Error).message).not.toContain(USER_A);
  });
});
