import { createHash } from "node:crypto";

import { z } from "zod";

import { getSourceAdapter, missingAdapterEnv } from "@/lib/jobs/sources/registry";
import type { JobSourceAdapter, JobSourceSlug } from "@/lib/jobs/sources/types";
import { abortableSleep, runSourceSync } from "@/lib/jobs/sync";
import {
  addJobSourceRunCounts,
  createJobSourceRun,
  findJobSourceRunByTaskId,
  finishJobSourceRun,
  getJobSource,
  getJobSourceBoard,
  getJobSourceRun,
  markJobSourceBoardFailed,
  markJobSourceBoardSynced,
  touchJobSource,
  type JobSourceRunRow,
} from "@/lib/supabase/queries/sources";
import { enqueueTask } from "@/lib/tasks/enqueue";
import { TaskError } from "@/lib/tasks/errors";
import type { DeadTaskContext, TaskContext, TaskHandlerResult } from "@/lib/tasks/types";

/**
 * `ingest.sync_source` (docs/ARCHITECTURE.md §13.4.3, §13.6.6).
 *
 * Payload `{ source, boardId?, cursor?, runId? }`: ids and enums only.
 * Enqueued daily per source/board by `enqueue_source_syncs()` (pg_cron
 * `kalify-ingest`, or the manual `GET /api/cron/sync-jobs`), and by itself
 * as a continuation when a sync runs past `SYNC_SOFT_LIMIT_MS`.
 *
 * 1. Load the source (and board). A disabled source/board, a source
 *    without an adapter, or an adapter missing its env is skipped
 *    (succeeds with `skipped`, logged), so turning a source off never
 *    dead-letters queued work.
 * 2. Create or continue the `job_source_runs` row: a continuation carries
 *    `runId`; a retried attempt of the first task finds its run by
 *    `task_id`. So one run per daily sync, however many tasks it takes.
 * 3. `runSourceSync` (lib/jobs/sync.ts) pages, upserts, resolves dupes,
 *    and closes missing snapshot rows when complete.
 * 4. Add this task's counts to the run. Then either enqueue the
 *    continuation (dedupe key includes the cursor) or finish the run
 *    (`succeeded`) and mark the source/board synced.
 *
 * onDead: the run becomes `partial` (something was fetched) or `failed`,
 * and a board's failure streak goes up (disabled at 5).
 *
 * Not yet: enqueueing `jobs.submit_requirement_batch` after a finished run
 * (§13.6.6 step 5). That kind arrives with M2.2; enqueueing it now would
 * leave tasks no deployment can run.
 */

export const SYNC_SOURCE_KIND = "ingest.sync_source";

const SOURCE_SLUGS = ["themuse", "usajobs", "greenhouse", "lever", "adzuna"] as const satisfies readonly JobSourceSlug[];

export const syncSourcePayloadSchema = z.strictObject({
  source: z.enum(SOURCE_SLUGS),
  boardId: z.uuid().optional(),
  cursor: z.string().min(1).max(512).optional(),
  runId: z.uuid().optional(),
});

export type SyncSourcePayload = z.output<typeof syncSourcePayloadSchema>;

/** UTC `YYYY-MM-DD`, the same date `enqueue_source_syncs()` puts in its keys. */
export function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

const SAFE_CURSOR = /^[A-Za-z0-9:._-]{1,64}$/;

/**
 * `ingest:{slug}:{board}:{date}[:{page_cursor}]` (§13.4.3). Long or
 * unusual cursors are replaced by a short hash so the key stays within the
 * 300-character `dedupe_key` check and free of odd characters.
 */
export function syncSourceDedupeKey(args: {
  source: JobSourceSlug;
  boardToken: string | null;
  nowMs: number;
  cursor?: string | null;
}): string {
  const base = `ingest:${args.source}:${args.boardToken ?? "-"}:${utcDate(args.nowMs)}`;
  if (!args.cursor) return base;
  const part = SAFE_CURSOR.test(args.cursor)
    ? args.cursor
    : `h${createHash("sha256").update(args.cursor, "utf8").digest("hex").slice(0, 24)}`;
  return `${base}:${part}`;
}

export interface SyncSourceDeps {
  getAdapter?: (slug: JobSourceSlug) => JobSourceAdapter | null;
  env?: Record<string, string | undefined>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  enqueue?: typeof enqueueTask;
}

function skipped(reason: string, fields: Record<string, string | null>): TaskHandlerResult {
  return { outcome: "succeeded", result: { skipped: reason, ...fields } };
}

export function createSyncSourceHandler(deps: SyncSourceDeps = {}) {
  const getAdapter = deps.getAdapter ?? ((slug: JobSourceSlug) => getSourceAdapter(slug));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const enqueue = deps.enqueue ?? enqueueTask;

  return async function runSyncSourceTask(ctx: TaskContext<SyncSourcePayload>): Promise<TaskHandlerResult> {
    const { payload, task, admin, signal, log } = ctx;
    const startedAtMs = now();
    const opts = { signal };

    const source = await getJobSource(admin, payload.source, opts);
    if (!source) {
      throw new TaskError("unknown_payload", "Unknown job source.", { retryable: false });
    }
    if (!source.enabled) {
      log.info("source disabled; skipping sync", { source: source.slug });
      return skipped("source_disabled", { source: source.slug });
    }

    const adapter = getAdapter(source.slug);
    if (!adapter) {
      log.warn("no adapter registered for enabled source; skipping sync", { source: source.slug });
      return skipped("no_adapter", { source: source.slug });
    }
    const missing = missingAdapterEnv(adapter, deps.env);
    if (missing.length > 0) {
      // Names only, never values.
      log.warn("source adapter disabled: required env missing", { source: source.slug, missing: missing.join(",") });
      return skipped("missing_env", { source: source.slug });
    }

    let board = null;
    if (source.sync_mode === "snapshot") {
      if (!payload.boardId) {
        throw new TaskError("unknown_payload", "Snapshot source sync needs a boardId.", { retryable: false });
      }
      board = await getJobSourceBoard(admin, payload.boardId, opts);
      if (!board || board.source_slug !== source.slug) {
        throw new TaskError("unknown_payload", "Board not found for this source.", { retryable: false });
      }
      if (!board.enabled) {
        log.info("board disabled; skipping sync", { source: source.slug, board: board.board_token });
        return skipped("board_disabled", { source: source.slug, board: board.board_token });
      }
    } else if (payload.boardId) {
      throw new TaskError("unknown_payload", "Incremental source sync must not carry a boardId.", { retryable: false });
    }

    // ---- run record: create or continue ------------------------------
    let run: JobSourceRunRow | null = null;
    if (payload.runId) {
      run = await getJobSourceRun(admin, payload.runId, opts);
      if (!run || run.source_slug !== source.slug || run.board_id !== (board?.id ?? null)) {
        throw new TaskError("unknown_payload", "Run not found for this source/board.", { retryable: false });
      }
      if (run.status !== "running") {
        log.info("run already finished; skipping continuation", { source: source.slug, run_id: run.id });
        return skipped("run_finished", { source: source.slug, run_id: run.id });
      }
    } else {
      run = await findJobSourceRunByTaskId(admin, task.id, opts);
      if (run && run.status !== "running") {
        // A previous attempt of this task already finished the run.
        return skipped("run_finished", { source: source.slug, run_id: run.id });
      }
      if (!run) {
        run = await createJobSourceRun(admin, { sourceSlug: source.slug, boardId: board?.id ?? null, taskId: task.id }, opts);
        await touchJobSource(admin, source.slug, { lastRunAt: run.started_at }, opts);
      }
    }

    const outcome = await runSourceSync({
      admin,
      adapter,
      source,
      board,
      cursor: payload.cursor ?? null,
      runStartedAt: run.started_at,
      signal,
      startedAtMs,
      log,
      now,
      sleep,
    });

    await addJobSourceRunCounts(admin, run, outcome.counts, opts);

    const result = {
      source: source.slug,
      board: board?.board_token ?? null,
      run_id: run.id,
      pages: outcome.pagesFetched,
      ...outcome.counts,
      duplicates_changed: outcome.duplicatesChanged,
      continued: outcome.continuation !== null,
    };

    if (outcome.continuation) {
      const nowMs = now();
      await enqueue(
        admin,
        SYNC_SOURCE_KIND,
        {
          source: source.slug,
          ...(board ? { boardId: board.id } : {}),
          cursor: outcome.continuation.cursor,
          runId: run.id,
        },
        {
          dedupeKey: syncSourceDedupeKey({
            source: source.slug,
            boardToken: board?.board_token ?? null,
            nowMs,
            cursor: outcome.continuation.cursor,
          }),
          parentTaskId: task.id,
          runAfter: outcome.continuation.runAfterMs ? new Date(outcome.continuation.runAfterMs) : null,
        },
      );
      return { outcome: "succeeded", result };
    }

    const finished = await finishJobSourceRun(admin, { runId: run.id, status: "succeeded" }, opts);
    if (finished) {
      await touchJobSource(admin, source.slug, { lastSuccessAt: finished.finished_at ?? new Date(now()).toISOString() }, opts);
      if (board) await markJobSourceBoardSynced(admin, board.id, opts);
    }
    return { outcome: "succeeded", result };
  };
}

export const runSyncSourceTask = createSyncSourceHandler();

/**
 * onDead (at least once, idempotent): finish the run as `partial` when it
 * fetched anything, else `failed`, and count a board failure. The board
 * update only happens when this delivery is the one that finished the run,
 * so a redelivered hook doesn't count the failure twice.
 */
export async function onSyncSourceDead(ctx: DeadTaskContext<SyncSourcePayload>): Promise<void> {
  const { task, payload, admin, errorCode, signal, log } = ctx;
  const opts = { signal };

  let run: JobSourceRunRow | null = null;
  if (payload?.runId) run = await getJobSourceRun(admin, payload.runId, opts);
  if (!run) run = await findJobSourceRunByTaskId(admin, task.id, opts);
  if (!run || run.status !== "running") return;

  const finished = await finishJobSourceRun(
    admin,
    {
      runId: run.id,
      status: run.fetched > 0 ? "partial" : "failed",
      errorSummary: `Sync task ${task.id} died with ${errorCode}.`,
    },
    opts,
  );
  if (finished?.board_id) {
    const { disabled } = await markJobSourceBoardFailed(admin, { id: finished.board_id }, errorCode, opts);
    if (disabled) {
      log.warn("board disabled after repeated sync failures", { run_id: run.id, board_id: finished.board_id, alert: true });
    }
  }
}
