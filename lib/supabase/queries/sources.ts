import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  Database,
  JobSourceRunStatus,
  JobSourceSlug,
} from "@/types/database";

/**
 * Service-role access to the ingest tables from 0009 (`job_sources`,
 * `job_source_boards`, `job_source_runs`) and the ingest functions
 * (`enqueue_source_syncs`, `resolve_job_duplicates`). All three tables are
 * server-only (RLS on, no policies) and the functions are service_role
 * only, so every function here takes the admin client. Inside the §13.14
 * service-role boundary (`lib/supabase/queries/sources.ts`); callers are
 * `lib/jobs/**`, `lib/tasks/**` and `app/api/cron/**`.
 *
 * Error messages carry the operation plus PostgREST's code/message only.
 */

export type AdminClient = SupabaseClient<Database>;
export type JobSourceRow = Database["public"]["Tables"]["job_sources"]["Row"];
export type JobSourceBoardRow = Database["public"]["Tables"]["job_source_boards"]["Row"];
export type JobSourceRunRow = Database["public"]["Tables"]["job_source_runs"]["Row"];

export class SourceQueryError extends Error {
  readonly code: string | null;

  constructor(operation: string, error: { code?: string | null; message?: string | null }) {
    const code = error.code ?? null;
    super(`${operation} failed${code ? ` (${code})` : ""}: ${(error.message ?? "unknown error").slice(0, 300)}`);
    this.name = "SourceQueryError";
    this.code = code;
  }
}

export interface QueryOptions {
  signal?: AbortSignal;
}

function withSignal<B extends { abortSignal(signal: AbortSignal): B }>(
  builder: B,
  options: QueryOptions | undefined,
): B {
  return options?.signal ? builder.abortSignal(options.signal) : builder;
}

export async function getJobSource(
  admin: AdminClient,
  slug: JobSourceSlug,
  options?: QueryOptions,
): Promise<JobSourceRow | null> {
  const { data, error } = await withSignal(
    admin.from("job_sources").select("*").eq("slug", slug),
    options,
  ).maybeSingle();
  if (error) throw new SourceQueryError("getJobSource", error);
  return data;
}

export async function getJobSourceBoard(
  admin: AdminClient,
  id: string,
  options?: QueryOptions,
): Promise<JobSourceBoardRow | null> {
  const { data, error } = await withSignal(
    admin.from("job_source_boards").select("*").eq("id", id),
    options,
  ).maybeSingle();
  if (error) throw new SourceQueryError("getJobSourceBoard", error);
  return data;
}

export async function getJobSourceRun(
  admin: AdminClient,
  id: string,
  options?: QueryOptions,
): Promise<JobSourceRunRow | null> {
  const { data, error } = await withSignal(
    admin.from("job_source_runs").select("*").eq("id", id),
    options,
  ).maybeSingle();
  if (error) throw new SourceQueryError("getJobSourceRun", error);
  return data;
}

/** The run a task started (a retried attempt of the same task reuses it). */
export async function findJobSourceRunByTaskId(
  admin: AdminClient,
  taskId: string,
  options?: QueryOptions,
): Promise<JobSourceRunRow | null> {
  const { data, error } = await withSignal(
    admin
      .from("job_source_runs")
      .select("*")
      .eq("task_id", taskId)
      .order("started_at", { ascending: true })
      .limit(1)
      ,
    options,
  ).maybeSingle();
  if (error) throw new SourceQueryError("findJobSourceRunByTaskId", error);
  return data;
}

export async function createJobSourceRun(
  admin: AdminClient,
  args: { sourceSlug: JobSourceSlug; boardId: string | null; taskId: string },
  options?: QueryOptions,
): Promise<JobSourceRunRow> {
  const { data, error } = await withSignal(
    admin
      .from("job_source_runs")
      .insert({ source_slug: args.sourceSlug, board_id: args.boardId, task_id: args.taskId })
      .select("*")
      ,
    options,
  ).single();
  if (error || !data) throw new SourceQueryError("createJobSourceRun", error ?? { message: "no row returned" });
  return data;
}

export type RunCounts = {
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  closed: number;
  skipped_filtered: number;
  skipped_invalid: number;
};

export const ZERO_RUN_COUNTS: Readonly<RunCounts> = {
  fetched: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  closed: 0,
  skipped_filtered: 0,
  skipped_invalid: 0,
};

/**
 * Adds one task's counts to the run (read-modify-write). Only the task
 * holding the run's lease writes it, and a continuation is enqueued only
 * after this returns, so two writers never overlap.
 */
export async function addJobSourceRunCounts(
  admin: AdminClient,
  run: JobSourceRunRow,
  counts: RunCounts,
  options?: QueryOptions,
): Promise<JobSourceRunRow> {
  const current = (await getJobSourceRun(admin, run.id, options)) ?? run;
  const next: RunCounts = {
    fetched: current.fetched + counts.fetched,
    inserted: current.inserted + counts.inserted,
    updated: current.updated + counts.updated,
    unchanged: current.unchanged + counts.unchanged,
    closed: current.closed + counts.closed,
    skipped_filtered: current.skipped_filtered + counts.skipped_filtered,
    skipped_invalid: current.skipped_invalid + counts.skipped_invalid,
  };
  const { data, error } = await withSignal(
    admin.from("job_source_runs").update(next).eq("id", run.id).select("*"),
    options,
  ).single();
  if (error || !data) throw new SourceQueryError("addJobSourceRunCounts", error ?? { message: "no row returned" });
  return data;
}

/**
 * Moves a `running` run to a terminal status. Conditional on
 * `status = 'running'`, so a redelivered onDead hook or a zombie attempt
 * can't overwrite an outcome. Returns the updated row, or null when the run
 * was already terminal.
 */
export async function finishJobSourceRun(
  admin: AdminClient,
  args: { runId: string; status: Exclude<JobSourceRunStatus, "running">; errorSummary?: string | null },
  options?: QueryOptions,
): Promise<JobSourceRunRow | null> {
  const { data, error } = await withSignal(
    admin
      .from("job_source_runs")
      .update({
        status: args.status,
        finished_at: new Date().toISOString(),
        error_summary: args.errorSummary ? args.errorSummary.slice(0, 500) : null,
      })
      .eq("id", args.runId)
      .eq("status", "running")
      .select("*")
      ,
    options,
  ).maybeSingle();
  if (error) throw new SourceQueryError("finishJobSourceRun", error);
  return data;
}

export async function touchJobSource(
  admin: AdminClient,
  slug: JobSourceSlug,
  fields: { lastRunAt?: string; lastSuccessAt?: string },
  options?: QueryOptions,
): Promise<void> {
  const update: Database["public"]["Tables"]["job_sources"]["Update"] = {};
  if (fields.lastRunAt) update.last_run_at = fields.lastRunAt;
  if (fields.lastSuccessAt) update.last_success_at = fields.lastSuccessAt;
  if (Object.keys(update).length === 0) return;
  const { error } = await withSignal(admin.from("job_sources").update(update).eq("slug", slug), options);
  if (error) throw new SourceQueryError("touchJobSource", error);
}

/** After a successful board sync: reset the failure streak. */
export async function markJobSourceBoardSynced(
  admin: AdminClient,
  boardId: string,
  options?: QueryOptions,
): Promise<void> {
  const { error } = await withSignal(
    admin
      .from("job_source_boards")
      .update({ last_synced_at: new Date().toISOString(), consecutive_failures: 0, last_error_code: null })
      .eq("id", boardId),
    options,
  );
  if (error) throw new SourceQueryError("markJobSourceBoardSynced", error);
}

/** Consecutive failures after which a board is disabled (§13.3.3). */
export const BOARD_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * After a failed board sync: bump the failure streak and disable the board
 * at `BOARD_MAX_CONSECUTIVE_FAILURES` (e.g. a 404 because the board moved).
 */
export async function markJobSourceBoardFailed(
  admin: AdminClient,
  board: Pick<JobSourceBoardRow, "id">,
  errorCode: string,
  options?: QueryOptions,
): Promise<{ disabled: boolean }> {
  const current = await getJobSourceBoard(admin, board.id, options);
  if (!current) return { disabled: false };
  const failures = current.consecutive_failures + 1;
  const disabled = failures >= BOARD_MAX_CONSECUTIVE_FAILURES;
  const { error } = await withSignal(
    admin
      .from("job_source_boards")
      .update({
        consecutive_failures: failures,
        last_error_code: errorCode.slice(0, 64),
        ...(disabled ? { enabled: false } : {}),
      })
      .eq("id", board.id),
    options,
  );
  if (error) throw new SourceQueryError("markJobSourceBoardFailed", error);
  return { disabled };
}

/** Keys per `resolve_job_duplicates` call, to keep each statement short. */
export const RESOLVE_DUPLICATES_CHUNK = 500;

/** `resolve_job_duplicates` (0009), chunked. Returns the rows changed. */
export async function resolveJobDuplicates(
  admin: AdminClient,
  dedupeKeys: Iterable<string>,
  options?: QueryOptions,
): Promise<number> {
  const keys = [...new Set(dedupeKeys)].sort();
  let changed = 0;
  for (let i = 0; i < keys.length; i += RESOLVE_DUPLICATES_CHUNK) {
    const { data, error } = await withSignal(
      admin.rpc("resolve_job_duplicates", { p_dedupe_keys: keys.slice(i, i + RESOLVE_DUPLICATES_CHUNK) }),
      options,
    );
    if (error) throw new SourceQueryError("resolve_job_duplicates", error);
    changed += typeof data === "number" ? data : 0;
  }
  return changed;
}

/** `enqueue_source_syncs` (0009). Returns the number of syncs requested. */
export async function enqueueSourceSyncs(
  admin: AdminClient,
  options?: QueryOptions,
): Promise<number> {
  const { data, error } = await withSignal(admin.rpc("enqueue_source_syncs"), options);
  if (error) throw new SourceQueryError("enqueue_source_syncs", error);
  if (typeof data !== "number") throw new SourceQueryError("enqueue_source_syncs", { message: "no count returned" });
  return data;
}
