import type { SupabaseClient } from "@supabase/supabase-js";

import type { AiUsageProvider, Database } from "@/types/database";

/**
 * Thin wrappers over `ai_usage_events` (supabase/migrations/
 * 0007_background_infra.sql, docs/ARCHITECTURE.md §13.3.1, §13.9.4).
 * Server-only table: every function takes the **service-role** client.
 * Inside the §13.14 service-role boundary (`lib/supabase/queries/usage.ts`).
 *
 * Rows never hold prompt/response content or PII — only ids, model names,
 * token counts and cost.
 */

type AdminClient = SupabaseClient<Database>;
export type AiUsageEventInsert =
  Database["public"]["Tables"]["ai_usage_events"]["Insert"];

export class UsageQueryError extends Error {
  readonly code: string | null;

  constructor(operation: string, error: { code?: string | null; message?: string | null }) {
    const code = error.code ?? null;
    const detail = (error.message ?? "unknown error").slice(0, 300);
    super(`${operation} failed${code ? ` (${code})` : ""}: ${detail}`);
    this.name = "UsageQueryError";
    this.code = code;
  }
}

export async function insertAiUsageEvent(
  admin: AdminClient,
  row: AiUsageEventInsert,
): Promise<void> {
  const { error } = await admin.from("ai_usage_events").insert(row);
  if (error) throw new UsageQueryError("insert_ai_usage_event", error);
}

export interface AiSpendRow {
  provider: AiUsageProvider;
  operation: string;
  costUsd: number;
  calls: number;
}

/**
 * Spend since `since`, grouped by provider and operation. Aggregated in SQL
 * (`ai_spend_summary`) rather than summed client-side, because a
 * client-side sum would silently truncate at PostgREST's max_rows and
 * undercount spend.
 */
export async function getAiSpendSince(
  admin: AdminClient,
  since: Date,
  options?: { signal?: AbortSignal },
): Promise<AiSpendRow[]> {
  const query = admin.rpc("ai_spend_summary", {
    p_since: since.toISOString(),
  });
  const { data, error } = await (options?.signal ? query.abortSignal(options.signal) : query);
  if (error) throw new UsageQueryError("ai_spend_summary", error);

  return (data ?? []).map((row) => ({
    provider: row.provider,
    operation: row.operation,
    // numeric -> JSON number from PostgREST; coerce defensively in case a
    // proxy/serializer hands it over as a string.
    costUsd: Number(row.cost_usd) || 0,
    calls: Number(row.calls) || 0,
  }));
}
