import { describe, expect, it } from "vitest";

import { checkWorkerAuth } from "@/lib/tasks/workerAuth";

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/worker/tick", { method: "POST", headers });
}

const env = { WORKER_SECRET: "correct-horse-battery-staple" };

describe("checkWorkerAuth", () => {
  it("fails closed with 500 when WORKER_SECRET is unset or blank", () => {
    expect(checkWorkerAuth(req({ authorization: "Bearer x" }), {})).toMatchObject({ ok: false, status: 500 });
    expect(checkWorkerAuth(req({ authorization: "Bearer  " }), { WORKER_SECRET: "  " })).toMatchObject({
      ok: false,
      status: 500,
    });
  });

  it("returns 401 for a missing header", () => {
    expect(checkWorkerAuth(req(), env)).toMatchObject({ ok: false, status: 401 });
  });

  it("returns 401 for a non-Bearer scheme or empty token", () => {
    expect(checkWorkerAuth(req({ authorization: `Basic ${env.WORKER_SECRET}` }), env)).toMatchObject({ status: 401 });
    expect(checkWorkerAuth(req({ authorization: "Bearer " }), env)).toMatchObject({ status: 401 });
  });

  it("returns 401 for a wrong secret, including prefixes and different lengths", () => {
    for (const token of ["wrong", "correct-horse", `${env.WORKER_SECRET}x`, env.WORKER_SECRET.toUpperCase()]) {
      expect(checkWorkerAuth(req({ authorization: `Bearer ${token}` }), env)).toMatchObject({ ok: false, status: 401 });
    }
  });

  it("accepts the right secret", () => {
    expect(checkWorkerAuth(req({ authorization: `Bearer ${env.WORKER_SECRET}` }), env)).toEqual({ ok: true });
  });
});
