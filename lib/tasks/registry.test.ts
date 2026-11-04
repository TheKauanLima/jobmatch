import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  getTaskDefinition,
  kindsForClass,
  TASK_REGISTRY,
  validateTaskDefinition,
} from "@/lib/tasks/registry";
import type { TaskDefinition } from "@/lib/tasks/types";
import { WORKER_HARD_BUDGET_MS } from "@/lib/tasks/worker";

describe("task registry invariant (§13.4.3)", () => {
  it.each(Object.entries(TASK_REGISTRY))(
    "%s: lease ≥ maxDuration + 30 s and fits a worker tick",
    (kind, def) => {
      expect(validateTaskDefinition(kind, def as unknown as TaskDefinition, WORKER_HARD_BUDGET_MS)).toEqual([]);
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
    expect(validateTaskDefinition("resume.extract_profile", base, WORKER_HARD_BUDGET_MS)).toEqual([]);
    // ingest.sync_source: lease 270 s, max 220 000 ms
    expect(
      validateTaskDefinition(
        "ingest.sync_source",
        { ...base, class: "background", leaseSeconds: 270, maxDurationMs: 220_000 },
        WORKER_HARD_BUDGET_MS,
      ),
    ).toEqual([]);
  });

  it("rejects a lease within 30 s of the max duration", () => {
    const problems = validateTaskDefinition(
      "x.y",
      { ...base, leaseSeconds: 60, maxDurationMs: 30_001 },
      WORKER_HARD_BUDGET_MS,
    );
    expect(problems.join("\n")).toMatch(/leaseSeconds × 1000/);
  });

  it("rejects durations that can never be claimed by a tick", () => {
    const problems = validateTaskDefinition(
      "x.y",
      { ...base, leaseSeconds: 400, maxDurationMs: WORKER_HARD_BUDGET_MS },
      WORKER_HARD_BUDGET_MS,
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
      WORKER_HARD_BUDGET_MS,
    );
    expect(problems.length).toBeGreaterThanOrEqual(6);
  });
});
