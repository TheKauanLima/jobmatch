import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  getTaskDefinition,
  kindsForClass,
  TASK_REGISTRY,
  taskRegistry,
  validateTaskDefinition,
} from "@/lib/tasks/registry";
import type { TaskDefinition } from "@/lib/tasks/types";
import { WORKER_CLAIM_MARGIN_MS, WORKER_HARD_BUDGET_MS } from "@/lib/tasks/worker";

/**
 * What validateTaskDefinition checks maxDurationMs against (§13.4.2/§13.4.3):
 * maxDurationMs + WORKER_CLAIM_MARGIN_MS < WORKER_HARD_BUDGET_MS, i.e. < 270 000.
 */
const CLAIMABLE_BUDGET_MS = WORKER_HARD_BUDGET_MS - WORKER_CLAIM_MARGIN_MS;

describe("task registry invariant (§13.4.3)", () => {
  it.each(Object.entries(TASK_REGISTRY))(
    "%s: lease ≥ maxDuration + 30 s and fits a worker tick",
    (kind, def) => {
      expect(validateTaskDefinition(kind, def as unknown as TaskDefinition, CLAIMABLE_BUDGET_MS)).toEqual([]);
    },
  );

  it("registers maintenance.noop as a non-AI background kind", () => {
    const def = getTaskDefinition("maintenance.noop");
    expect(def).toBeDefined();
    expect(def?.class).toBe("background");
    expect(def?.usesAi).toBe(false);
    expect(kindsForClass("background")).toContain("maintenance.noop");
    expect(kindsForClass("user")).not.toContain("maintenance.noop");
  });

  it("does not resolve prototype keys as kinds", () => {
    expect(getTaskDefinition("constructor")).toBeUndefined();
    expect(getTaskDefinition("__proto__")).toBeUndefined();
    expect(getTaskDefinition("not.a_kind")).toBeUndefined();
  });
});

describe("validateTaskDefinition", () => {
  const base: TaskDefinition = {
    class: "user",
    priority: 100,
    maxAttempts: 3,
    leaseSeconds: 240,
    maxDurationMs: 170_000,
    usesAi: true,
    payloadSchema: z.object({}),
    handler: async () => ({ outcome: "succeeded" }),
  };

  it("accepts the §13.4.3 table's tightest real entries", () => {
    // resume.extract_profile: lease 240 s, max 170 000 ms (exactly +70 s)
    expect(validateTaskDefinition("resume.extract_profile", base, CLAIMABLE_BUDGET_MS)).toEqual([]);
    // ingest.sync_source: lease 270 s, max 220 000 ms
    expect(
      validateTaskDefinition(
        "ingest.sync_source",
        { ...base, class: "background", leaseSeconds: 270, maxDurationMs: 220_000 },
        CLAIMABLE_BUDGET_MS,
      ),
    ).toEqual([]);
  });

  it("rejects a lease within 30 s of the max duration", () => {
    const problems = validateTaskDefinition(
      "x.y",
      { ...base, leaseSeconds: 60, maxDurationMs: 30_001 },
      CLAIMABLE_BUDGET_MS,
    );
    expect(problems.join("\n")).toMatch(/leaseSeconds × 1000/);
  });

  it("rejects durations that can never be claimed by a tick", () => {
    const problems = validateTaskDefinition(
      "x.y",
      { ...base, leaseSeconds: 400, maxDurationMs: CLAIMABLE_BUDGET_MS },
      CLAIMABLE_BUDGET_MS,
    );
    expect(problems.join("\n")).toMatch(/hard budget/);
  });

  it("rejects bad kinds, classes, and numbers", () => {
    const problems = validateTaskDefinition(
      "NoDots",
      {
        ...base,
        class: "other" as never,
        priority: 1.5,
        maxAttempts: 0,
        leaseSeconds: -1,
        maxDurationMs: 0,
      },
      CLAIMABLE_BUDGET_MS,
    );
    expect(problems.length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// M1.3 (QA): registry invariant gaps.
// ---------------------------------------------------------------------------

describe("registry invariant — M1.3 additions", () => {
  const base: TaskDefinition = {
    class: "user",
    priority: 0,
    maxAttempts: 3,
    leaseSeconds: 60,
    maxDurationMs: 30_000,
    usesAi: false,
    payloadSchema: z.object({}),
    handler: async () => ({ outcome: "succeeded" }),
  };

  it("exact lease boundary: lease × 1000 === maxDuration + 30 s is accepted; 1 ms tighter is rejected", () => {
    expect(validateTaskDefinition("x.y", base, CLAIMABLE_BUDGET_MS)).toEqual([]);
    expect(
      validateTaskDefinition("x.y", { ...base, maxDurationMs: 30_001 }, CLAIMABLE_BUDGET_MS).join("\n"),
    ).toMatch(/leaseSeconds × 1000/);
  });

  it("exact budget boundary: maxDurationMs + claim margin === hard budget is rejected; 1 ms less is accepted", () => {
    // The static form of the §13.4.2 claim rule: 270 000 = 285 000 − 15 000.
    expect(CLAIMABLE_BUDGET_MS).toBe(270_000);
    const lease = Math.ceil((CLAIMABLE_BUDGET_MS + 30_000) / 1000);
    expect(
      validateTaskDefinition("x.y", { ...base, leaseSeconds: lease, maxDurationMs: CLAIMABLE_BUDGET_MS - 1 }, CLAIMABLE_BUDGET_MS),
    ).toEqual([]);
    expect(
      validateTaskDefinition("x.y", { ...base, leaseSeconds: lease, maxDurationMs: CLAIMABLE_BUDGET_MS }, CLAIMABLE_BUDGET_MS).join("\n"),
    ).toMatch(/hard budget minus the claim margin/);
  });

  it("rejects non-finite numbers (NaN / Infinity) instead of letting comparisons silently pass", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateTaskDefinition("x.y", { ...base, leaseSeconds: bad }, CLAIMABLE_BUDGET_MS)).not.toEqual([]);
      expect(validateTaskDefinition("x.y", { ...base, maxDurationMs: bad }, CLAIMABLE_BUDGET_MS)).not.toEqual([]);
      expect(validateTaskDefinition("x.y", { ...base, maxAttempts: bad }, CLAIMABLE_BUDGET_MS)).not.toEqual([]);
    }
  });

  it("rejects a kind longer than the DB check (char_length ≤ 100)", () => {
    const kind = `a.${"b".repeat(99)}`;
    expect(kind.length).toBe(101);
    expect(validateTaskDefinition(kind, base, CLAIMABLE_BUDGET_MS).join("\n")).toMatch(/≤ 100/);
  });

  it("taskRegistry (worker view) and TASK_REGISTRY (typed view) are the same table", () => {
    expect(Object.keys(taskRegistry).sort()).toEqual(Object.keys(TASK_REGISTRY).sort());
    for (const kind of Object.keys(TASK_REGISTRY)) {
      expect(getTaskDefinition(kind)).toBe((TASK_REGISTRY as Record<string, unknown>)[kind]);
    }
  });

  it("every class's kinds partition the registry (no kind in both or neither)", () => {
    const user = kindsForClass("user");
    const bg = kindsForClass("background");
    expect(user.filter((k) => bg.includes(k))).toEqual([]);
    expect([...user, ...bg].sort()).toEqual(Object.keys(TASK_REGISTRY).sort());
  });

  it("the SQL enqueue_task default lease (300 s, migration 0007) covers every registered kind", () => {
    for (const [kind, d] of Object.entries(TASK_REGISTRY)) {
      expect(300_000, kind).toBeGreaterThanOrEqual((d as unknown as TaskDefinition).maxDurationMs + 30_000);
    }
  });

  // The §13.4.3 table (docs/ARCHITECTURE.md) lists the kinds later milestones
  // add. Asserting the invariant against the table now means a kind copied
  // from it verbatim can never fail the registry test later.
  const PLANNED: Array<[string, "user" | "background", number, number, number, number]> = [
    // kind, class, priority, maxAttempts, leaseSeconds, maxDurationMs
    ["resume.extract_text", "user", 100, 3, 120, 60_000],
    ["resume.extract_profile", "user", 100, 3, 240, 170_000],
    ["resume.critique", "user", 90, 3, 270, 200_000],
    ["resume.embed_profile", "user", 100, 5, 90, 30_000],
    ["resume.build_matches", "user", 100, 3, 120, 60_000],
    ["resume.rerank_role", "user", 90, 3, 240, 170_000],
    ["resume.narrate_roles", "user", 90, 3, 240, 170_000],
    ["match.fit_check", "user", 80, 3, 270, 200_000],
    ["import.fetch_listing", "user", 80, 3, 90, 45_000],
    ["jobs.extract_requirements_sync", "user", 60, 3, 240, 150_000],
    ["jobs.submit_requirement_batch", "background", 20, 5, 120, 60_000],
    ["jobs.poll_requirement_batch", "background", 20, 10, 270, 200_000],
    ["jobs.embed_pending", "background", 20, 5, 270, 200_000],
    ["ingest.sync_source", "background", 10, 4, 270, 220_000],
    ["market.refresh_stats", "background", 10, 3, 180, 120_000],
    ["digest.plan", "background", 10, 3, 120, 60_000],
    ["digest.send_user", "background", 30, 4, 240, 150_000],
    ["maintenance.backfill_job_keys", "background", 5, 3, 270, 200_000],
  ];

  it.each(PLANNED)("§13.4.3 planned kind %s satisfies the invariant", (kind, cls, priority, maxAttempts, leaseSeconds, maxDurationMs) => {
    expect(
      validateTaskDefinition(kind, { ...base, class: cls, priority, maxAttempts, leaseSeconds, maxDurationMs }, CLAIMABLE_BUDGET_MS),
    ).toEqual([]);
    // Also within the SQL default lease, so a SQL-side enqueue by name is safe.
    expect(leaseSeconds).toBeLessThanOrEqual(300);
  });

  it("registered kinds that already appear in the §13.4.3 table use the table's values", () => {
    for (const [kind, cls, priority, maxAttempts, leaseSeconds, maxDurationMs] of PLANNED) {
      const d = getTaskDefinition(kind);
      if (!d) continue;
      expect({ cls: d.class, p: d.priority, a: d.maxAttempts, l: d.leaseSeconds, m: d.maxDurationMs }, kind).toEqual({
        cls, p: priority, a: maxAttempts, l: leaseSeconds, m: maxDurationMs,
      });
    }
  });
});
