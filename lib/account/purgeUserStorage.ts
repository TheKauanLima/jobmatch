import type { SupabaseClient } from "@supabase/supabase-js";

import { RESUME_STORAGE_BUCKET } from "@/lib/storage/resumeFiles";
import type { Database } from "@/types/database";

/**
 * Removes every object under `{user_id}/` in the private `resumes` bucket
 * (docs/ARCHITECTURE.md §13.13.7 step 3). Account deletion needs this because
 * deleting the `auth.users` row cascades every table row but does NOT remove
 * Storage objects — those must go through the Storage API.
 *
 * Must be called with the service-role (admin) client: by the time this runs
 * the caller is authenticated, but the purge has to be complete regardless of
 * any Storage RLS edge cases, and §13.14 allows admin usage in `lib/account/**`.
 *
 * Algorithm (per §13.13.7): list the prefix 100 entries at a time from offset
 * 0, remove what was listed, and repeat until a list comes back empty.
 * Listing from offset 0 every time (rather than advancing an offset) is
 * deliberate — removed objects drop out of the listing, so advancing an
 * offset would skip entries. Nested "folders" (entries with `id === null`)
 * are purged recursively, so this does not rely on today's flat
 * `{user_id}/{id}.{ext}` path convention.
 *
 * Safety rails (this runs with RLS bypassed, so a bad prefix would be
 * catastrophic):
 *   - The real protection is the uuid check: `userId` must be a canonical
 *     uuid (fixed length, no `/`), so the listed prefix is always exactly one
 *     top-level folder. An empty or malformed id would make the prefix the
 *     bucket root (every user's files) — refused outright. Combined with
 *     Storage's folder-scoped `list` semantics and the 0002 insert policy
 *     (`storage.foldername(name)[1] = auth.uid()::text`, i.e. every object's
 *     top-level folder is its owner's fixed-length uuid), the purge can only
 *     ever see this user's objects.
 *   - Every path handed to `remove` is also re-checked to start with
 *     `{user_id}/`. Given the above this cannot fire today; it is a cheap
 *     guard against a future edit to the path-building code, not the primary
 *     defense.
 *   - Progress is enforced: if a `remove` call deletes nothing and a re-list
 *     shows the same objects still there, or the round budget is exhausted,
 *     it throws rather than looping forever. (A `remove` that deletes nothing
 *     because a concurrent request — another tab's `DELETE /api/resumes/:id`,
 *     or a double-submitted `DELETE /api/account` — removed those objects
 *     first is progress, not a failure.)
 *
 * Any Storage error throws `StoragePurgeError` immediately; objects already
 * removed stay removed, and re-running picks up where it stopped (it simply
 * lists what's left), so the operation is idempotent and safely retryable.
 *
 * PII: object paths are `{uuid}/{uuid}.{ext}` (server-generated, no
 * user-supplied names), and nothing here logs anything — errors carry the
 * Storage error message only.
 */

export const STORAGE_PURGE_PAGE_SIZE = 100;

/**
 * Upper bound on rounds for one purge call (shared across all prefixes it
 * descends into). A round is one `list` plus at most one `remove` (or, rarely,
 * one extra re-list after an empty `remove`), i.e. ~2–3 Storage requests.
 * Budgeting a pessimistic ~250 ms per request ⇒ ≤ ~0.5–0.75 s per round, so
 * 50 rounds ≈ 25–38 s. That leaves margin inside the route's
 * `maxDuration = 60` for re-auth, `deleteUser`, the post-delete sweep, and
 * cookie clearing. 50 × 100 = 5,000 objects per attempt — orders of magnitude
 * above any real account (a handful of resumes).
 *
 * Every list counts as a round, including the per-folder ones, so a layout
 * with many nested folders (not produced by today's flat
 * `{user_id}/{id}.{ext}` convention) may need more than one attempt. That
 * still converges: each attempt's removals stick and the retry lists only
 * what remains. `deleteAccount` never calls `deleteUser` until a purge
 * attempt finishes cleanly. (`options.maxRounds` overrides the cap; it
 * exists for tests only.)
 *
 * Exceeding the cap throws (retryable). And if the platform times the request
 * out anyway, that happens before `deleteUser` (step 4 runs only after the
 * purge resolves), so the account is left intact and a retry continues from
 * whatever objects remain.
 */
export const STORAGE_PURGE_MAX_ROUNDS = 50;

/** Max folder nesting below `{user_id}/` that the purge will descend into. */
export const STORAGE_PURGE_MAX_DEPTH = 8;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StoragePurgeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "StoragePurgeError";
  }
}

type AdminClient = SupabaseClient<Database>;

type PurgeState = { rounds: number; maxRounds: number; removed: number };

/**
 * Purges `{userId}/` in the `resumes` bucket. Resolves with the number of
 * objects removed (0 when there was nothing left — the idempotent re-run
 * case). Throws `StoragePurgeError` on any failure.
 */
export async function purgeUserResumeObjects(
  admin: AdminClient,
  userId: string,
  options: { maxRounds?: number } = {},
): Promise<{ removed: number }> {
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    throw new StoragePurgeError(
      "Refusing to purge Storage: user id is not a valid uuid.",
    );
  }

  const state: PurgeState = {
    rounds: 0,
    maxRounds: options.maxRounds ?? STORAGE_PURGE_MAX_ROUNDS,
    removed: 0,
  };
  await purgePrefix(admin, userId, userId, 0, state);
  return { removed: state.removed };
}

type Bucket = ReturnType<AdminClient["storage"]["from"]>;

/** One page of direct children of `prefix`, always from offset 0. */
async function listPage(bucket: Bucket, prefix: string) {
  const { data, error } = await bucket.list(prefix, {
    limit: STORAGE_PURGE_PAGE_SIZE,
    offset: 0,
    sortBy: { column: "name", order: "asc" },
  });

  if (error) {
    throw new StoragePurgeError(
      `Failed to list Storage objects: ${error.message}`,
      error,
    );
  }
  return data ?? [];
}

async function purgePrefix(
  admin: AdminClient,
  userId: string,
  prefix: string,
  depth: number,
  state: PurgeState,
): Promise<void> {
  if (depth > STORAGE_PURGE_MAX_DEPTH) {
    throw new StoragePurgeError(
      "Storage purge aborted: folder nesting exceeds the supported depth.",
    );
  }

  const bucket = admin.storage.from(RESUME_STORAGE_BUCKET);

  for (;;) {
    state.rounds += 1;
    if (state.rounds > state.maxRounds) {
      throw new StoragePurgeError(
        "Storage purge aborted: exceeded the maximum number of list/remove rounds.",
      );
    }

    const entries = await listPage(bucket, prefix);
    if (entries.length === 0) {
      return;
    }

    const folders = entries.filter((entry) => entry.id === null);
    const files = entries.filter((entry) => entry.id !== null);

    for (const folder of folders) {
      await purgePrefix(
        admin,
        userId,
        `${prefix}/${folder.name}`,
        depth + 1,
        state,
      );
    }

    if (files.length === 0) {
      // A page of folders only: they were just emptied above, so they will
      // no longer appear in the next listing. The round budget guards the
      // (pathological) case where they somehow keep reappearing.
      continue;
    }

    const paths = files.map((file) => `${prefix}/${file.name}`);
    for (const path of paths) {
      if (!path.startsWith(`${userId}/`)) {
        throw new StoragePurgeError(
          "Refusing to remove a Storage object outside the user's prefix.",
        );
      }
    }

    const { data: removed, error: removeError } = await bucket.remove(paths);

    if (removeError) {
      throw new StoragePurgeError(
        `Failed to remove Storage objects: ${removeError.message}`,
        removeError,
      );
    }

    const removedCount = removed?.length ?? 0;
    if (removedCount === 0) {
      // Either a concurrent request already removed these objects (fine —
      // that's progress), or Storage is reporting success without deleting
      // (stuck — listing again would return the same page forever). Re-list
      // once to tell the two apart; only the stuck case throws.
      const remaining = await listPage(bucket, prefix);
      const attempted = new Set(files.map((file) => file.name));
      const stuck = remaining.some(
        (entry) => entry.id !== null && attempted.has(entry.name),
      );
      if (stuck) {
        throw new StoragePurgeError(
          "Storage purge made no progress: remove() deleted no objects.",
        );
      }
      continue;
    }

    state.removed += removedCount;
  }
}
