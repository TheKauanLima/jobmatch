# Kalify v2 — Progress Log

Running log of what's been done, what's in flight, and what's next. Design lives in
`docs/ARCHITECTURE.md` §13; milestone definitions live in `docs/ROADMAP.md`. Update
this file at the end of every work session.

---

## Session 2026-11-04

### Done
- **Renamed the product to Kalify** (user-facing strings, docs, agent definitions).
  Internal identifiers (package name, Supabase project id, repo URL,
  `jobmatch-theme` storage key, applied migrations) intentionally unchanged.
  Committed in `0a4a5b7`.
- **Live database caught up:** migrations 0004–0006 had never been applied to the
  live Supabase project (`xpubgotqrsosvpiwlpyh`). Applied all three. Job search,
  level filters and editing/soft-deleting own listings now work against the live DB.
- **Job board populated:** ran The Muse sync once → 205 listings (100 Internship,
  100 Entry Level, 5 user-submitted).
- **v2 design written** by the architect: `docs/ARCHITECTURE.md` §13 and
  `docs/ROADMAP.md` (5 phases, ~35 milestones). CLAUDE.md updated with the revised
  privacy model (private custom listings) and AI stack (embeddings, background work).
  Committed in `0a4a5b7`; later §13/ROADMAP edits from this session are below.
- **M1.4a — Self-serve account deletion (backend): DONE, reviewer APPROVED WITH NITS,
  all nits fixed.** `DELETE /api/account` (`app/api/account/route.ts`,
  `lib/account/**`, schema in `lib/validation/schemas.ts`). 91 tests.
  §13.13.7 / §13.14 updated to record the implementation details the review flagged.
- **M1.1 — Claude layer v2: IMPLEMENTED, review NOT finished.** `lib/claude/**`
  rewritten for `claude-opus-5-5` with structured outputs (`beta.messages.create` +
  `output_config.format` + server-side refusal fallbacks), typed error
  classification, usage/cost accounting with an injectable sink, extended
  prompt-injection escaping, semantic validation. Repair/retry machinery
  (`repairListField`, `MAX_MATCH_ATTEMPTS`, forced tool use) deleted. v1 analyze and
  match routes adapted with unchanged response shapes; verified end-to-end with real
  API calls (~$0.02–0.03 per call). "Verified" note added to §13.5.2.
  **Note:** the live site's analyze/match now call `claude-opus-5-5` once deployed.
- **Rate limit for account-deletion password checks** designed (`account_reauth`,
  10/user/day) and added to §13.3.1/§13.13.7 and to migration 0007.

### In progress — stopped mid-way at the user's request
- **M1.2 — Background task infrastructure: PARTIAL, NOT reviewed, NOT applied.**
  Written: `supabase/migrations/0007_background_infra.sql` (incl. `account_reauth`),
  `0008_worker_schedule.sql`, `lib/tasks/**` (types, registry, enqueue, kick, budget,
  errors, usageSink, workerAuth, worker, maintenance.noop handler),
  `app/api/worker/{tick,status}/route.ts`, `lib/supabase/queries/{tasks,usage}.ts`,
  `types/database.ts`, `.env.local.example`.
  Missing: the worker-loop test (`lib/tasks/worker.test.ts`) the agent was writing
  when stopped; final self-check; report of ops steps.
  **Do NOT apply 0007/0008 to the live database until M1.2 is finished and reviewed.**
  Deploying this code is safe: the worker route fails closed without
  `WORKER_SECRET`, and nothing schedules it until 0008 is applied.
- **M1.1 review:** reviewer was stopped right at the start; must be re-run.
- **`enum` decision (architect):** the SDK's `zodOutputFormat` strips `enum` from the
  wire schema; architect was asked to decide whether `callStructured` re-injects it.
  Stopped before answering; re-ask.

### Next steps (in order)
1. Resume M1.2: finish `lib/tasks/worker.test.ts`, run full checks, produce ops notes.
2. Wire the usage sink: register `setUsageSink(recordAiUsageEvent)` (from
   `lib/tasks/usageSink.ts`) in a module imported by every server entry point that
   calls Claude, including the two v1 routes.
3. Reviewer: M1.1 and M1.2.
4. Apply 0007 + 0008 to the live DB; create Vault secrets `kalify_worker_url` and
   `kalify_worker_secret`; set `WORKER_SECRET` and `APP_BASE_URL` in Vercel
   (production only); check Deployment Protection doesn't block `/api/worker/tick`.
5. Architect: `enum` decision (above).
6. M1.4c (re-auth rate limit wiring, cancel-tasks gate flip, `GET /api/account/limits`,
   move test fake to `/tests/fakes/`), then M1.3 QA, then M1.4b settings UI.
7. Consider setting `maxDuration` on the v1 analyze/match routes (Claude task
   timeout 160s + one retry) — flagged by M1.1, pending review.

### Open decisions for the user (ARCHITECTURE.md §13.19)
1. Embeddings provider — recommended Voyage AI (`voyage-4-lite`); blocks M2.4.
2. Cheaper model for bulk job extraction — recommended: stay on Opus with a 300/day
   cap until the M2.5 eval, then switch if quality holds.
3. Budget caps — $15/day global AI, $5/day ingestion, per-user daily limits.
4. Job sources — USAJOBS (user gets a free key), curated Greenhouse/Lever boards;
   defer Adzuna.
5. URL-import deny-list (LinkedIn, Indeed, Glassdoor, Handshake).
6. Email provider — Resend; blocks Phase 5.
7. Custom listing visibility — explicit choice, Private pre-highlighted.

---

## Sessions 2026-11-05 and 2026-11-09

### Done
- **M1.1 — Claude layer v2: APPROVED** (review → CHANGES REQUIRED → fixed → re-review
  APPROVED WITH NITS, doc nits applied). Fixes: v1 analyze/match routes export
  `maxDuration = 300` with a hard 270s deadline (`callStructured` races the SDK
  promise against the signal because the SDK's retry sleep ignores it; 120s
  per-attempt timeout) so a resume can never be left `processing`; price table adds
  claude-opus-5 / sonnet-5 / opus-4-8 with an explicit $5/$25 unknown-model ceiling and
  strict id matching; escaping hardened (NFKC, `\p{Default_Ignorable_Code_Point}`,
  repeated slashes).
- **M1.1b added to roadmap:** restore `enum` constraints on the wire schema for small
  closed enums (after a 25-call enforcement probe); taxonomy values stay free text.
  Must land before M2.2/M2.3.
- **M1.2 — Background task infrastructure: APPROVED** (review → APPROVED WITH NITS →
  fix pass → re-review APPROVED WITH NITS, "safe to apply" → final nits fixed and
  verified by the orchestrator). Additions from review: dead-task hook outbox
  (`claim_dead_task_hooks` / `complete_dead_task_hook` / `release_dead_task_hook`,
  swept every tick + fast path), stale-lease sweep (`dead_letter_stale_tasks`, cron
  `kalify-stale-leases`), over-budget deferral without claiming
  (`defer_queued_tasks`), preview deployments refuse to act as the worker (403),
  two-key advisory locks, DB call timeouts, alertable `[ALERT][...]` log lines.
  Usage sink wired into the worker and both v1 routes. 919 tests; SQL validated on
  PGlite (123 checks). All 19 functions explicitly revoke PUBLIC execute (verified).
- §13 kept in sync with every review outcome; ROADMAP gained M1.1b, M1.4c, and quote
  display tasks in M3.2/M3.6 (show original text, not NFKC-normalized quotes).

- **0007 + 0008 APPLIED to the live database** (2026-11-09, via the Supabase
  connector, files sent verbatim). Verified: 4 active `kalify-*` cron jobs owned by
  postgres; all 19 functions owned by postgres with `search_path=""`;
  anon/authenticated cannot execute any service function; `invoke_worker_tick` not
  executable by service_role; no USAGE on `private` for anon/authenticated; RLS on
  all 4 new tables, only `rate_limit_events` selectable by authenticated; rate-limit
  seed rows present. Smoke test in a rolled-back transaction passed (dedupe, claim,
  fencing, retry→dead, hook outbox, tick skips without Vault secrets). Advisors:
  expected "RLS enabled, no policy" INFO on `background_tasks`, `ai_usage_events`,
  `private.rate_limits`; WARN "authenticated can execute SECURITY DEFINER" on
  `get_my_rate_limits` / `consume_account_reauth_attempt` — intended (both no-arg,
  scoped to `auth.uid()`); leaked-password protection still off (user to-do).
- **Generated types diffed against `types/database.ts`:** no drift; only deliberate
  narrowings (recorded in the file header).
- **M1.4c — Account hardening: APPROVED** (review → APPROVED WITH NITS → nits fixed,
  checks re-run by the orchestrator: 953 tests, tsc and eslint clean).
  `lib/rateLimit.ts` (v2 rate-limit module); `DELETE /api/account` charges an
  `account_reauth` attempt before any GoTrue call (false → 429, RPC error → 500,
  23503/42501 → 401 for the concurrent-delete race); one shared 500 copy;
  `CANCEL_TASKS_FOR_USER_ENABLED` gate and `lib/account/cancelUserTasks.ts` deleted,
  deletion always calls `queries/tasks.ts#cancelQueuedTasksForUser` first;
  `GET /api/account/limits`; test fake moved to `tests/fakes/supabaseStorage.ts`,
  `no-restricted-imports` lint rule keeps `lib/`/`app/` off `tests/**`.
  Live check (rolled back): 10 attempts allowed, 11th refused. pgTAP criterion
  handed off to M1.3 (recorded in ROADMAP). §13.9.3 / §13.13.7 / §13.14 synced.

- **Production was pointed at the wrong database (fixed).** A Vercel Marketplace
  Supabase resource, `supabase-bole-bell` (project `scvkmuiajdizsoxlepgo`, Free plan,
  owned by the Vercel team, not in the user's Supabase org), was connected to the
  `jobmatch` Vercel project and had replaced the Supabase env vars in Production and
  Preview. Disconnected it; set `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` (JobMatch,
  verified by key `ref`) and `SUPABASE_SERVICE_ROLE_KEY` (sensitive) on Production +
  Preview; redeployed. The resource still exists. Delete it only after the user
  confirms nothing needs it. Any sign-ups made while it was connected live there,
  not in JobMatch.
- **Worker secrets:** `WORKER_SECRET`, `APP_BASE_URL` (Vercel Production) and Vault
  `kalify_worker_url` / `kalify_worker_secret` are set; ticks return 202.

### Next steps (in order)
1. ~~Apply 0007 → 0008 and verify~~ — done.
2. ~~Regenerate/diff types~~ — done.
3. User: generate `WORKER_SECRET`; set `WORKER_SECRET` + `APP_BASE_URL` on Vercel
   **Production only**; deploy; then create Vault secrets `kalify_worker_url` and
   `kalify_worker_secret`; check Deployment Protection doesn't block
   `/api/worker/tick`. Then run the M1.2 acceptance check (`maintenance.noop`).
4. ~~M1.4c~~ — done.
5. M1.3 QA (now also: `consume_account_reauth_attempt` pgTAP, handed off from M1.4c) (pgTAP + two-connection concurrency script — reviewer listed exactly
   what it must cover), M1.1b, M1.4b settings UI, then M1.5 ingestion.
6. Housekeeping: one-time line-ending renormalization commit (M1.4a files and
   `.gitignore` are CRLF) plus a `.gitattributes` with `* text=auto eol=lf`.

### User to-dos (not blocking current work)
- Check `CRON_SECRET` is set in Vercel (needed for the daily job sync).
- Enable leaked-password protection in Supabase Auth settings.
