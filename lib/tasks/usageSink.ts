import { createAdminClient } from "@/lib/supabase/admin";
import {
  insertAiUsageEvent,
  type AiUsageEventInsert,
} from "@/lib/supabase/queries/usage";
import type { AdminClient } from "@/lib/supabase/queries/tasks";
import type { AiUsageProvider } from "@/types/database";

/**
 * Database-backed usage sink: writes one `ai_usage_events` row per billed
 * AI API call (docs/ARCHITECTURE.md §13.3.1, §13.5.2 step 3, §13.9.4).
 *
 * Registered with the Claude layer's `setUsageSink()` (lib/claude/usage.ts,
 * M1.1). The event shape below is a structural superset of M1.1's
 * `UsageEvent` (it also allows provider `voyage` for the embeddings layer,
 * M2.4), so `recordAiUsageEvent` registers directly, no adapter needed.
 *
 * Guarantees:
 * - Never throws. The call it records has already been billed; failing it
 *   would make the task retry and pay twice. Failures are logged without
 *   content (and events contain no content anyway: ids, enums, token
 *   counts, money).
 * - Normalizes defensively before insert so a single malformed field never
 *   loses the row: non-finite/negative token counts → 0; malformed uuids →
 *   null; over-long strings truncated to the column limits. An invalid cost
 *   is stored as 0 with a warning so the row (and its tokens) survive for
 *   reconciliation.
 * - Uses the service-role client (the table is server-only). This module
 *   is inside the §13.14 service-role boundary (`lib/tasks/**`).
 */

export interface AiUsageEvent {
  provider: AiUsageProvider;
  operation: string;
  model: string;
  isBatch?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  stopReason?: string | null;
  requestId?: string | null;
  userId?: string | null;
  taskId?: string | null;
  taskAttempt?: number | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS: readonly AiUsageProvider[] = ["anthropic", "voyage"];
const MAX_INT4 = 2_147_483_647;
/** numeric(12,6) holds up to 999 999.999999. */
const MAX_COST_USD = 999_999.999999;

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.round(value), MAX_INT4);
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/**
 * Maps an event to an insert row, or returns null (with a reason) when the
 * event can't be stored at all.
 */
export function toUsageRow(
  event: AiUsageEvent,
): { row: AiUsageEventInsert; warnings: string[] } | { row: null; reason: string } {
  if (!PROVIDERS.includes(event.provider)) {
    return { row: null, reason: "invalid provider" };
  }
  const operation = text(event.operation, 100);
  const model = text(event.model, 200);
  if (!operation || !model) {
    return { row: null, reason: "missing operation or model" };
  }

  const warnings: string[] = [];

  let costUsd = 0;
  if (typeof event.costUsd === "number" && Number.isFinite(event.costUsd) && event.costUsd >= 0) {
    costUsd = Math.min(Math.round(event.costUsd * 1_000_000) / 1_000_000, MAX_COST_USD);
  } else {
    warnings.push("invalid cost stored as 0");
  }

  if (event.userId != null && uuidOrNull(event.userId) === null) {
    warnings.push("malformed user_id stored as null");
  }
  if (event.taskId != null && uuidOrNull(event.taskId) === null) {
    warnings.push("malformed task_id stored as null");
  }

  const attempt =
    typeof event.taskAttempt === "number" &&
    Number.isInteger(event.taskAttempt) &&
    event.taskAttempt >= 0 &&
    event.taskAttempt <= MAX_INT4
      ? event.taskAttempt
      : null;

  return {
    row: {
      provider: event.provider,
      operation,
      model,
      is_batch: event.isBatch === true,
      input_tokens: tokenCount(event.inputTokens),
      output_tokens: tokenCount(event.outputTokens),
      cache_read_tokens: tokenCount(event.cacheReadTokens),
      cache_write_tokens: tokenCount(event.cacheWriteTokens),
      cost_usd: costUsd,
      stop_reason: text(event.stopReason, 100),
      request_id: text(event.requestId, 200),
      user_id: uuidOrNull(event.userId),
      task_id: uuidOrNull(event.taskId),
      task_attempt: attempt,
    },
    warnings,
  };
}

export function createDatabaseUsageSink(
  options: { getAdmin?: () => AdminClient } = {},
): (event: AiUsageEvent) => Promise<void> {
  const getAdmin = options.getAdmin ?? createAdminClient;
  let admin: AdminClient | null = null;

  return async (event) => {
    const logFields = {
      provider: typeof event?.provider === "string" ? event.provider : null,
      operation: typeof event?.operation === "string" ? event.operation.slice(0, 100) : null,
      request_id: typeof event?.requestId === "string" ? event.requestId.slice(0, 200) : null,
    };

    try {
      const mapped = toUsageRow(event);
      if (mapped.row === null) {
        console.error(`[usageSink] usage event not recorded (${mapped.reason})`, JSON.stringify(logFields));
        return;
      }
      for (const warning of mapped.warnings) {
        console.warn(`[usageSink] ${warning}`, JSON.stringify(logFields));
      }

      admin ??= getAdmin();
      await insertAiUsageEvent(admin, mapped.row);
    } catch (err) {
      console.error(
        "[usageSink] failed to record usage event",
        JSON.stringify({
          ...logFields,
          error: err instanceof Error ? err.name : "unknown",
          code:
            err && typeof err === "object" && "code" in err && typeof err.code === "string"
              ? err.code
              : null,
        }),
      );
    }
  };
}

/** The sink to register: `setUsageSink(recordAiUsageEvent)`. */
export const recordAiUsageEvent = createDatabaseUsageSink();
