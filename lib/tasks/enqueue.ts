import {
  enqueueTaskRow,
  type AdminClient,
} from "@/lib/supabase/queries/tasks";
import {
  getTaskDefinition,
  type TaskKind,
  type TaskPayloadInput,
} from "@/lib/tasks/registry";
import type { Json } from "@/types/database";

/**
 * Enqueue a background task (docs/ARCHITECTURE.md §13.4). Class, priority,
 * max attempts and lease come from the registry, never from the caller.
 *
 * Idempotent per `dedupeKey` (§13.4.4 rule 1): while a task with the same
 * key is queued/running, the existing task's id is returned and nothing is
 * inserted.
 *
 * Rules for callers:
 * - `userId` comes from the verified session or the parent task row, never
 *   from request input (§13.3.1, §13.15 item 3).
 * - `payload` holds ids and small enums only — never resume/job text or
 *   PII. It is validated against the kind's schema here, so a bad payload
 *   never reaches the queue.
 * - Routes that enqueue user-facing work then call `kickWorker()` inside
 *   `after()` (§13.4.2).
 */

/** Mirrors the `background_tasks.payload` size check in 0007. */
export const MAX_PAYLOAD_BYTES = 4096;

export interface EnqueueOptions {
  userId?: string | null;
  dedupeKey?: string | null;
  correlationId?: string | null;
  parentTaskId?: string | null;
  /** Defaults to now. */
  runAfter?: Date | null;
}

export class EnqueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnqueueValidationError";
  }
}

export async function enqueueTask<K extends TaskKind>(
  admin: AdminClient,
  kind: K,
  payload: TaskPayloadInput<K>,
  options: EnqueueOptions = {},
): Promise<string> {
  const def = getTaskDefinition(kind);
  if (!def) {
    throw new EnqueueValidationError(`enqueueTask: unknown task kind "${kind}".`);
  }

  const parsed = def.payloadSchema.safeParse(payload);
  if (!parsed.success) {
    // Report only the failing paths, never the values.
    const paths = parsed.error.issues
      .map((issue) => issue.path.join(".") || "(root)")
      .join(", ");
    throw new EnqueueValidationError(
      `enqueueTask: invalid payload for "${kind}" at: ${paths}.`,
    );
  }

  const value = parsed.data as Json;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EnqueueValidationError(
      `enqueueTask: payload for "${kind}" must be a JSON object.`,
    );
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_PAYLOAD_BYTES) {
    throw new EnqueueValidationError(
      `enqueueTask: payload for "${kind}" exceeds ${MAX_PAYLOAD_BYTES} bytes (ids and small enums only).`,
    );
  }

  return enqueueTaskRow(admin, {
    kind,
    taskClass: def.class,
    payload: value,
    userId: options.userId ?? null,
    dedupeKey: options.dedupeKey ?? null,
    priority: def.priority,
    maxAttempts: def.maxAttempts,
    leaseSeconds: def.leaseSeconds,
    runAfter: options.runAfter ?? null,
    correlationId: options.correlationId ?? null,
    parentTaskId: options.parentTaskId ?? null,
  });
}
