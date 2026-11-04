import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deleteAccount is exercised with the REAL Storage purge and task-cancel
 * modules against an in-memory fake admin client (Storage + auth.admin), so
 * ordering, failure, and retry behavior are tested end to end at the module
 * level. Only the password check and the admin-client factory are mocked.
 */

const { mockVerifyPassword, mockCreateAdminClient } = vi.hoisted(() => ({
  mockVerifyPassword: vi.fn(),
  mockCreateAdminClient: vi.fn(),
}));

vi.mock("@/lib/account/reauthenticate", () => ({
  verifyPassword: mockVerifyPassword,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}));

const { AuthApiError } = await import("@supabase/supabase-js");
const { deleteAccount } = await import("@/lib/account/deleteAccount");
const { createFakeStorage, resumePaths, USER_A, USER_B } = await import(
  "@/lib/account/testing/fakeStorage"
);

const EMAIL = "student@example.test";
const PASSWORD = "s3cret-Pa55word";

type FakeStorageOpts = Parameters<typeof createFakeStorage>[1];

function setupWorld(params: {
  paths: string[];
  storageOpts?: FakeStorageOpts;
  deleteUserImpl?: (id: string) => Promise<{ error: unknown }>;
}) {
  const fake = createFakeStorage(params.paths, params.storageOpts);
  const users = new Set([USER_A, USER_B]);
  const events: string[] = [];

  const origList = fake.storage.from("resumes").list;
  const origRemove = fake.storage.from("resumes").remove;
  fake.calls.from.length = 0;
  const bucket = {
    list: async (...args: Parameters<typeof origList>) => {
      events.push("storage.list");
      return origList(...args);
    },
    remove: async (...args: Parameters<typeof origRemove>) => {
      events.push("storage.remove");
      return origRemove(...args);
    },
  };

  const deleteUser = vi.fn(async (id: string, ...rest: [boolean?]) => {
    void rest;
    events.push("auth.deleteUser");
    if (params.deleteUserImpl) return params.deleteUserImpl(id);
    users.delete(id);
    return { data: { user: null }, error: null };
  });

  const admin = {
    storage: { from: () => bucket },
    auth: { admin: { deleteUser } },
    rpc: vi.fn(),
  };
  mockCreateAdminClient.mockReturnValue(admin);

  return { fake, users, events, deleteUser, admin };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyPassword.mockResolvedValue("ok");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // No log line may ever contain the password or the email.
  for (const call of errorSpy.mock.calls) {
    const line = call.map(String).join(" ");
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain(EMAIL);
  }
  errorSpy.mockRestore();
});

const input = { userId: USER_A, email: EMAIL, password: PASSWORD };

describe("deleteAccount — happy path", () => {
  it("purges all of the user's Storage objects (2 resumes) and then hard-deletes the auth user", async () => {
    const otherUsersFiles = resumePaths(USER_B, 2);
    const world = setupWorld({
      paths: [...resumePaths(USER_A, 2), ...otherUsersFiles],
    });

    const result = await deleteAccount(input);

    expect(result).toEqual({ ok: true });
    expect([...world.fake.objects].sort()).toEqual(otherUsersFiles.sort());
    expect(world.users.has(USER_A)).toBe(false);
    expect(world.users.has(USER_B)).toBe(true);
    expect(world.deleteUser).toHaveBeenCalledWith(USER_A, false);
  });

  it("re-authenticates first, with the session's user id and email", async () => {
    setupWorld({ paths: [] });

    await deleteAccount(input);

    expect(mockVerifyPassword).toHaveBeenCalledWith({
      userId: USER_A,
      email: EMAIL,
      password: PASSWORD,
    });
  });

  it("orders the steps: every Storage removal happens before deleteUser", async () => {
    const world = setupWorld({ paths: resumePaths(USER_A, 230) });

    await deleteAccount(input);

    const firstDelete = world.events.indexOf("auth.deleteUser");
    const lastRemoveBeforeDelete = world.events.lastIndexOf(
      "storage.remove",
      firstDelete,
    );
    expect(firstDelete).toBeGreaterThan(-1);
    expect(world.events.slice(0, firstDelete)).toContain("storage.remove");
    expect(lastRemoveBeforeDelete).toBeLessThan(firstDelete);
    expect(world.events.filter((e) => e === "storage.remove")).toHaveLength(3);
    expect(world.fake.objects.size).toBe(0);
  });

  it("does not call cancel_tasks_for_user while the M1.2 feature gate is off", async () => {
    const world = setupWorld({ paths: [] });

    await deleteAccount(input);

    expect(world.admin.rpc).not.toHaveBeenCalled();
  });

  it("succeeds for a user with no Storage objects at all", async () => {
    const world = setupWorld({ paths: [] });

    await expect(deleteAccount(input)).resolves.toEqual({ ok: true });
    expect(world.users.has(USER_A)).toBe(false);
  });
});

describe("deleteAccount — re-authentication", () => {
  it("wrong password → reauth_failed, and nothing is touched (no admin client, no Storage, no delete)", async () => {
    mockVerifyPassword.mockResolvedValue("invalid");
    const world = setupWorld({ paths: resumePaths(USER_A, 2) });

    const result = await deleteAccount(input);

    expect(result).toEqual({ ok: false, reason: "reauth_failed" });
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(world.events).toEqual([]);
    expect(world.fake.objects.size).toBe(2);
    expect(world.users.has(USER_A)).toBe(true);
  });

  it("password check unavailable → failed at reauth (not reported as a wrong password), nothing touched", async () => {
    mockVerifyPassword.mockResolvedValue("unavailable");
    const world = setupWorld({ paths: resumePaths(USER_A, 2) });

    const result = await deleteAccount(input);

    expect(result).toEqual({ ok: false, reason: "failed", step: "reauth" });
    expect(world.events).toEqual([]);
  });

  it("verifyPassword throwing (missing env) → failed at reauth, nothing touched", async () => {
    mockVerifyPassword.mockRejectedValue(new Error("env missing"));
    const world = setupWorld({ paths: resumePaths(USER_A, 1) });

    const result = await deleteAccount(input);

    expect(result).toEqual({ ok: false, reason: "failed", step: "reauth" });
    expect(world.events).toEqual([]);
  });
});

describe("deleteAccount — Storage failure deletes nothing else and is retryable", () => {
  it("a list failure stops before deleteUser; the account still exists", async () => {
    const world = setupWorld({
      paths: resumePaths(USER_A, 2),
      storageOpts: { failList: () => true },
    });

    const result = await deleteAccount(input);

    expect(result).toEqual({
      ok: false,
      reason: "failed",
      step: "storage_purge",
    });
    expect(world.deleteUser).not.toHaveBeenCalled();
    expect(world.users.has(USER_A)).toBe(true);
    expect(world.fake.objects.size).toBe(2);
  });

  it("a mid-purge remove failure stops before deleteUser, and a retry completes cleanly", async () => {
    let failing = true;
    const world = setupWorld({
      paths: resumePaths(USER_A, 250),
      storageOpts: { failRemove: (n) => failing && n === 2 },
    });

    const first = await deleteAccount(input);

    expect(first).toEqual({
      ok: false,
      reason: "failed",
      step: "storage_purge",
    });
    expect(world.deleteUser).not.toHaveBeenCalled();
    expect(world.users.has(USER_A)).toBe(true);
    expect(world.fake.objects.size).toBe(150);

    failing = false;
    const retry = await deleteAccount(input);

    expect(retry).toEqual({ ok: true });
    expect(world.fake.objects.size).toBe(0);
    expect(world.deleteUser).toHaveBeenCalledTimes(1);
    expect(world.users.has(USER_A)).toBe(false);
  });

  it("an admin client that can't be created (missing service key) fails before any deletion", async () => {
    setupWorld({ paths: resumePaths(USER_A, 1) });
    mockCreateAdminClient.mockImplementation(() => {
      throw new Error("createAdminClient: env missing");
    });

    const result = await deleteAccount(input);

    expect(result).toEqual({ ok: false, reason: "failed", step: "setup" });
    expect(mockVerifyPassword).toHaveBeenCalled();
  });
});

describe("deleteAccount — deleteUser failures and idempotency", () => {
  it("deleteUser error → failed at delete_user; a retry (Storage already empty) completes", async () => {
    let failDelete = true;
    const users = new Set([USER_A]);
    const world = setupWorld({
      paths: resumePaths(USER_A, 2),
      deleteUserImpl: async (id) => {
        if (failDelete) {
          return { error: new AuthApiError("Database error", 500, undefined) };
        }
        users.delete(id);
        return { error: null };
      },
    });

    const first = await deleteAccount(input);
    expect(first).toEqual({ ok: false, reason: "failed", step: "delete_user" });
    expect(users.has(USER_A)).toBe(true);
    expect(world.fake.objects.size).toBe(0);

    failDelete = false;
    const retry = await deleteAccount(input);

    expect(retry).toEqual({ ok: true });
    expect(users.has(USER_A)).toBe(false);
    expect(world.deleteUser).toHaveBeenCalledTimes(2);
  });

  it("deleteUser throwing → failed at delete_user", async () => {
    setupWorld({
      paths: [],
      deleteUserImpl: async () => {
        throw new Error("socket closed");
      },
    });

    await expect(deleteAccount(input)).resolves.toEqual({
      ok: false,
      reason: "failed",
      step: "delete_user",
    });
  });

  it("deleteUser 404 user_not_found (a concurrent request already finished) counts as success", async () => {
    setupWorld({
      paths: [],
      deleteUserImpl: async () => ({
        error: new AuthApiError("User not found", 404, "user_not_found"),
      }),
    });

    await expect(deleteAccount(input)).resolves.toEqual({ ok: true });
  });

  it("the post-delete sweep removes an object uploaded during the race window between purge and deleteUser", async () => {
    const raced = `${USER_A}/99999999-0000-4000-8000-000000000000.pdf`;
    const ref: { objects?: Set<string> } = {};
    const world = setupWorld({
      paths: resumePaths(USER_A, 2),
      deleteUserImpl: async () => {
        // A second tab's upload landed after the purge finished but before
        // the auth user was deleted.
        ref.objects!.add(raced);
        return { error: null };
      },
    });
    ref.objects = world.fake.objects;

    const result = await deleteAccount(input);

    expect(result).toEqual({ ok: true });
    expect(world.fake.objects.has(raced)).toBe(false);
    expect(world.fake.objects.size).toBe(0);
    const deleteIdx = world.events.indexOf("auth.deleteUser");
    expect(world.events.slice(deleteIdx + 1)).toContain("storage.remove");
  });

  it("runs a best-effort Storage sweep after deleteUser, and its failure doesn't fail the deletion", async () => {
    // List calls: #1 returns the files, #2 empty (purge done), then
    // deleteUser, then #3 (the sweep) fails.
    const world = setupWorld({
      paths: resumePaths(USER_A, 2),
      storageOpts: { failList: (n) => n === 3 },
    });

    const result = await deleteAccount(input);

    expect(result).toEqual({ ok: true });
    const deleteIdx = world.events.indexOf("auth.deleteUser");
    expect(world.events.slice(deleteIdx + 1)).toContain("storage.list");
    expect(world.users.has(USER_A)).toBe(false);
  });
});
