import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared-secret auth for the machine-to-machine worker routes
 * (`POST /api/worker/tick`, `GET /api/worker/status`; docs/ARCHITECTURE.md
 * §13.4.2, §13.13.8, §13.15 item 10).
 *
 * - `WORKER_SECRET` unset/blank → 500 (fail closed: an unset secret must
 *   never become "no auth required").
 * - Missing/malformed/wrong `Authorization: Bearer <secret>` → 401.
 * - Compared with `crypto.timingSafeEqual` over SHA-256 digests, so the
 *   comparison is constant-time and doesn't leak the secret's length.
 */

export type WorkerAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; error: string };

const BEARER_PREFIX = "Bearer ";

export function checkWorkerAuth(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): WorkerAuthResult {
  const expected = env.WORKER_SECRET?.trim();
  if (!expected) {
    return { ok: false, status: 500, error: "Worker endpoint is not configured." };
  }

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const presented = header.slice(BEARER_PREFIX.length);
  if (presented.length === 0) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return secretsMatch(presented, expected)
    ? { ok: true }
    : { ok: false, status: 401, error: "Unauthorized" };
}

function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
