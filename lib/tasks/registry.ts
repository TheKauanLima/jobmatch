import type { z } from "zod";

import {
  noopPayloadSchema,
  runNoopTask,
} from "@/lib/tasks/handlers/maintenance/noop";
import type { TaskClass, TaskDefinition } from "@/lib/tasks/types";

/**
 * Task registry (docs/ARCHITECTURE.md §13.4.3). The worker only claims
 * kinds listed here, so a task enqueued by newer code (e.g. a preview
 * deployment sharing the one Supabase project) waits for a deployment that
 * knows it instead of being dead-lettered.
 *
 * Invariant (unit-tested for every kind): `leaseSeconds × 1000 ≥
 * maxDurationMs + 30 000`, and `maxDurationMs` fits inside one worker tick.
 *
 * Later milestones add the kinds in the §13.4.3 table here, with the
 * table's class / priority / max attempts / lease / max ms values.
 */

/** Identity helper that keeps each entry's payload type precise. */
export function defineTask<S extends z.ZodType>(
  definition: TaskDefinition<S>,
): TaskDefinition<S> {
  return definition;
}

export const TASK_REGISTRY = {
  "maintenance.noop": defineTask({
    class: "background",
    priority: 0,
    maxAttempts: 3,
    leaseSeconds: 60,
    maxDurationMs: 10_000,
    usesAi: false,
    payloadSchema: noopPayloadSchema,
    handler: runNoopTask,
  }),
} as const;

export type TaskKind = keyof typeof TASK_REGISTRY;
export type TaskPayloadInput<K extends TaskKind> = z.input<
  (typeof TASK_REGISTRY)[K]["payloadSchema"]
>;

/** Registry viewed as a plain lookup table (worker side). */
export type TaskRegistry = Readonly<Record<string, TaskDefinition>>;

export const taskRegistry: TaskRegistry = TASK_REGISTRY as unknown as TaskRegistry;

export function getTaskDefinition(
  kind: string,
  registry: TaskRegistry = taskRegistry,
): TaskDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(registry, kind)
    ? registry[kind]
    : undefined;
}

export function kindsForClass(
  taskClass: TaskClass,
  registry: TaskRegistry = taskRegistry,
): string[] {
  return Object.entries(registry)
    .filter(([, def]) => def.class === taskClass)
    .map(([kind]) => kind);
}

/** Lease must exceed the handler budget by at least this much (§13.4.3). */
export const LEASE_MARGIN_MS = 30_000;

/**
 * Returns a list of invariant violations for one definition (empty = ok).
 * `workerHardBudgetMs` is passed in to avoid a registry → worker import.
 */
export function validateTaskDefinition(
  kind: string,
  def: TaskDefinition,
  workerHardBudgetMs: number,
): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(kind) || kind.length > 100) {
    problems.push(`${kind}: kind must be dotted lower_snake (e.g. "resume.critique"), ≤ 100 chars`);
  }
  if (def.class !== "user" && def.class !== "background") {
    problems.push(`${kind}: class must be "user" or "background"`);
  }
  if (!Number.isInteger(def.priority) || def.priority < -32768 || def.priority > 32767) {
    problems.push(`${kind}: priority must be a smallint`);
  }
  if (!Number.isInteger(def.maxAttempts) || def.maxAttempts < 1) {
    problems.push(`${kind}: maxAttempts must be an integer ≥ 1`);
  }
  if (!Number.isInteger(def.leaseSeconds) || def.leaseSeconds <= 0) {
    problems.push(`${kind}: leaseSeconds must be a positive integer`);
  }
  if (!Number.isInteger(def.maxDurationMs) || def.maxDurationMs <= 0) {
    problems.push(`${kind}: maxDurationMs must be a positive integer`);
  }
  if (def.leaseSeconds * 1000 < def.maxDurationMs + LEASE_MARGIN_MS) {
    problems.push(
      `${kind}: leaseSeconds × 1000 (${def.leaseSeconds * 1000}) must be ≥ maxDurationMs + ${LEASE_MARGIN_MS} (${def.maxDurationMs + LEASE_MARGIN_MS})`,
    );
  }
  if (def.maxDurationMs >= workerHardBudgetMs) {
    problems.push(`${kind}: maxDurationMs must be < the worker hard budget (${workerHardBudgetMs})`);
  }
  if (typeof def.handler !== "function") {
    problems.push(`${kind}: handler must be a function`);
  }
  return problems;
}
