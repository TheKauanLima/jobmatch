/**
 * In-memory stand-in for `supabase.storage.from(bucket)` used by the
 * lib/account tests. Models the parts of Supabase Storage the purge relies
 * on: `list(prefix, { limit, offset })` returns the direct children of a
 * prefix (files with an `id`, virtual folders with `id: null`), sorted by
 * name; `remove(paths)` deletes the existing ones and returns them.
 *
 * Failure injection: `failList` / `failRemove` decide per call (1-based call
 * number) whether that call returns a Storage error instead.
 *
 * Test-only helper; all data is synthetic.
 */

export type FakeStorageOptions = {
  failList?: (callNumber: number) => boolean;
  failRemove?: (callNumber: number) => boolean;
  /** Simulates a broken backend that reports success but deletes nothing. */
  removeIsNoop?: boolean;
  /**
   * Runs just before each `remove` call is applied (1-based call number),
   * with direct access to the object set — used to simulate a concurrent
   * request deleting the same objects between `list` and `remove`.
   */
  beforeRemove?: (
    callNumber: number,
    paths: string[],
    objects: Set<string>,
  ) => void;
};

export function createFakeStorage(
  initialPaths: string[],
  options: FakeStorageOptions = {},
) {
  const objects = new Set(initialPaths);
  const calls = {
    from: [] as string[],
    list: [] as { prefix: string; limit?: number; offset?: number }[],
    remove: [] as string[][],
  };

  const bucketApi = {
    async list(
      prefix: string,
      opts: { limit?: number; offset?: number } = {},
    ) {
      calls.list.push({ prefix, limit: opts.limit, offset: opts.offset });
      if (options.failList?.(calls.list.length)) {
        return { data: null, error: { message: "simulated list failure" } };
      }

      const children = new Map<string, { name: string; id: string | null }>();
      for (const path of objects) {
        if (!path.startsWith(`${prefix}/`)) continue;
        const rest = path.slice(prefix.length + 1);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          children.set(`f:${rest}`, { name: rest, id: `id:${path}` });
        } else {
          const folder = rest.slice(0, slash);
          children.set(`d:${folder}`, { name: folder, id: null });
        }
      }

      const sorted = [...children.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? 100;
      return { data: sorted.slice(offset, offset + limit), error: null };
    },

    async remove(paths: string[]) {
      calls.remove.push([...paths]);
      if (options.failRemove?.(calls.remove.length)) {
        return { data: null, error: { message: "simulated remove failure" } };
      }
      options.beforeRemove?.(calls.remove.length, paths, objects);
      if (options.removeIsNoop) {
        return { data: [], error: null };
      }
      const removed = [];
      for (const path of paths) {
        if (objects.delete(path)) {
          removed.push({ name: path, id: `id:${path}` });
        }
      }
      return { data: removed, error: null };
    },
  };

  const storage = {
    from(bucket: string) {
      calls.from.push(bucket);
      return bucketApi;
    },
  };

  return { storage, objects, calls };
}

/** Synthetic uuids for tests. */
export const USER_A = "11111111-1111-4111-8111-111111111111";
export const USER_B = "22222222-2222-4222-8222-222222222222";

export function resumePaths(userId: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) =>
      `${userId}/${String(i).padStart(8, "0")}-0000-4000-8000-000000000000.pdf`,
  );
}
