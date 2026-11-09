# Kalify v2 Roadmap

Source of truth for *design*: `docs/ARCHITECTURE.md` §13. This file sequences the work.
Each milestone is sized for one agent run and one coherent PR. Tags: **[BE]**
backend-dev, **[FE]** frontend-dev, **[QA]** qa-tester, **[RV]** reviewer.

**Rules that apply to every milestone (not repeated below):**
- **[RV] gate:** reviewer checks the PR against §13 and the §13.15 checklist before the
  milestone counts as done. A blocking finding sends it back to the owner.
- Migrations are new files only (0007+), applied in the order of §13.3.0. Regenerate
  `types/database.ts` after each one. Never edit 0001–0006.
- Each milestone updates `.env.local.example` and adds tests for its own code. The
  separate [QA] milestones cover cross-cutting and adversarial testing.
- If a milestone has to deviate from §13, the owner stops and reports back to the
  orchestrator. Architect updates §13 first; the code never silently diverges.
- 🟢 marks milestones that can start immediately.
- ⛔ marks milestones blocked on a user decision (§13.19).

---

## Phase 1 — Stabilize

### M1.1 🟢 Claude layer v2 foundation [BE]
Implements §13.5.1–13.5.3, 13.5.5, 13.5.6 (helpers). Depends on: nothing.
1. [BE] Verify SDK behavior against installed `@anthropic-ai/sdk`:
   - `beta.messages.parse` with `output_config.format` + `fallbacks` + the
     `server-side-fallback-2026-07-01` beta;
   - `zodOutputFormat` with zod v4;
   - handling of unsupported constraints;
   - the non-streaming `max_tokens` guard at 20k.
   Record findings in §13.5.2 (a short "Verified" note).
2. [BE] `lib/claude/config.ts`, `errors.ts`, `usage.ts` (price table plus an
   injectable `recordUsage` sink, no-op until M1.2), and `client.ts#callStructured`
   with full stop_reason/parsed_output/error classification.
3. [BE] `promptEscaping.ts`: `RESERVED_TAG_WORDS`, `escapeUntrusted` (handles
   attributes), `wrapUntrusted`. `promptCommon.ts#UNTRUSTED_DATA_RULES`.
   `semanticValidation.ts` helpers.
4. [BE] Migrate `analyzeResume` and `matchResumeToJob` to `callStructured` on
   `claude-opus-5-5` (effort medium), preserving their current output shapes. Delete
   `repairListField`, `repairMatchResponseShape`, `extractToolUseInput`, the forced-tool
   definitions, and the `MAX_MATCH_ATTEMPTS` loop. Add semantic checks (score int
   0..100, non-empty strings).

**Acceptance:**
- No `tool_choice`, `temperature`, `top_p`, or `top_k` anywhere in `lib/claude`.
- v1 analyze and match routes work end-to-end on Opus 5.5 (manual check with a real
  key, results noted in the PR).
- Unit tests cover refusal, max_tokens, null parsed_output, 400 vs 429/529
  classification, and escaping with attributes plus zero-width splitting.
- `parse.ts` is reduced to (or replaced by) semantic validation.

### M1.1b Structured-output `enum` restore [BE]
Implements the §13.5.2 "Decision on `enum`" block. Depends on: M1.1 merged. **Must
land before M2.2 and M2.3**, the first enum-heavy schemas. Small (one PR).
1. [BE] `scripts/evals/structured-output-probe.ts` (manual, real key): 20 sync + 5
   batch runs on `claude-opus-5-5` with an out-of-enum-pushing prompt. Record the
   result in §13.5.2 next to the decision block, either "enforced" or "not enforced".
2. [BE] `lib/claude/outputFormat.ts#buildOutputFormat` with `restoreEnums`,
   `WIRE_ENUM_MAX_VALUES = 64`, and `WIRE_ENUM_RESTORE` (set from the probe result).
   Use it in both `callStructured` and the batch request builder.
3. [BE] Tests per §13.5.2 decision item 5: wire-schema snapshots, enum-path coverage,
   nullable→`null`, no other keywords added, the oversized-enum guard, and
   sync/batch parity.

**Acceptance:**
- The probe result is recorded.
- With `WIRE_ENUM_RESTORE = true`, every closed enum in the M1.1-migrated schemas
  appears on the wire, and a live call still returns `end_turn`.
- With it set to `false`, the wire schema is byte-identical to the helper output.
- No data-driven vocabulary (skill/role slugs) is a `z.enum`.

### M1.2 🟢 Background task infrastructure [BE]
Implements §13.3.1, 13.3.2, 13.4. Depends on: nothing (in parallel with M1.1).
1. [BE] Migration `0007_background_infra.sql`: `private` schema, `background_tasks`,
   `ai_usage_events`, `rate_limit_events`, `private.rate_limits`, all task functions,
   `consume_rate_limit`, `get_my_rate_limits`. Include the revokes and grants.
2. [BE] Migration `0008_worker_schedule.sql`: pg_cron and pg_net, plus the tick,
   purge, and cron-history jobs that read Vault secrets and fail closed when absent.
3. [BE] `lib/tasks/{types,registry,enqueue,kick,worker,errors,budget}.ts`.
   `app/api/worker/tick/route.ts` returns 202 and runs `after()`.
   Add `app/api/worker/status/route.ts`. Register `maintenance.noop` (test kind only).
4. [BE] Wire the `recordUsage` sink from M1.1 to `ai_usage_events`. Add the global
   budget check in the worker.
5. [BE] Write ops notes in the PR description: Vault secrets to create, plus
   `WORKER_SECRET`/`APP_BASE_URL` set on production only.
6. [BE] **Review fix pass**, folded into 0007/0008 before they are applied:
   - the dead-task hook outbox: columns, `claim_dead_task_hooks`,
     `complete_dead_task_hook`, the worker sweep plus fast path, and purge only once
     handled (§13.4.5);
   - `dead_letter_stale_tasks` plus the `kalify-stale-leases` cron;
   - two-key advisory locks;
   - default-privilege revoke on `private`;
   - no `service_role` grant on `invoke_worker_tick`;
   - the `VERCEL_ENV` production guard on tick and kick;
   - admin-call timeouts;
   - `dead_hooks_pending` in the status route.

   Tests per §13.4.5.

**Acceptance:**
- After the user or orchestrator creates the Vault secrets, a `maintenance.noop` task
  enqueued in SQL is processed within ~60s.
- A forced-failure noop retries with backoff and ends `dead`.
- Two concurrent ticks never exceed the class caps.
- Unknown kinds are left `queued`.
- The tick route returns 401 for a wrong secret and 500 when the secret is unset.

### M1.3 QA: task infra and Claude layer [QA]
Depends on: M1.1, M1.2. Implements §13.16 (DB and idempotency subsets).
1. [QA] Set up the pgTAP harness (`supabase/tests/database/`, local `supabase start`)
   and document how to run it.
2. [QA] pgTAP tests:
   - `claim_tasks` (caps, skip locked, lease expiry, dead at max attempts)
   - fencing in `complete_task` and `fail_task`
   - the dedupe partial unique index
   - `snooze_task` not counting an attempt
   - atomic `consume_rate_limit`
   - execute privileges revoked on service functions
   - RLS on the three new tables
3. [QA] vitest: worker loop budget logic (doesn't start tasks that won't fit), the
   self-kick conditions, and the registry invariant.
4. [QA] Adversarial unit tests for `escapeUntrusted`: every reserved word,
   attributes, nesting, mixed case, whitespace and zero-width splitting.

**Acceptance:** all tests green locally. Any bugs found are filed back to
M1.1/M1.2 owners and fixed.

### M1.4a 🟢 Self-serve account deletion — backend [BE]
Implements §13.13.7, §13.3.12. Depends on: nothing. Integrates
`cancel_tasks_for_user` once M1.2 lands; before that, skip the call behind a feature
check.
1. [BE] `lib/account/deleteAccount.ts`: password re-auth on a throwaway client,
   paginated Storage purge under `{user_id}/`, `auth.admin.deleteUser`, and
   idempotent re-runs.
2. [BE] `DELETE /api/account` with zod body `{password, confirm:'DELETE'}`, sign-out,
   and `maxDuration = 60`.
3. [BE] (Added at review.) Implement the hardening in §13.13.7:
   - the re-auth outcome mapping (credentials rejected → 403; outage → 500);
   - throwaway-session revoke;
   - `user_not_found` treated as success;
   - the post-delete Storage sweep;
   - cookie-expiry backstop;
   - the re-list-once no-progress guard;
   - a `STORAGE_PURGE_MAX_ROUNDS` sized to fit `maxDuration = 60`, with its
     reasoning in the docstring.

**Acceptance:**
- A test user with 2 resumes is fully gone: no `storage.objects` rows under their
  prefix, no rows in any user-linked table.
- A shared listing they submitted remains with `submitted_by = null`.
- A wrong password returns 403.
- A GoTrue 429/5xx/network failure returns 500, not 403.
- A simulated Storage failure deletes nothing else and can be retried.
- A concurrent double-submit doesn't loop or error spuriously.

### M1.4b Account deletion and settings UI [FE]
Depends on: M1.4a (deletion form); M1.4c (usage panel and the `account_reauth` 429).
Implements §13.13.7, §13.14 (`/settings`).
1. [FE] `/settings` page with `DeleteAccountForm`. The copy states what is deleted
   and that shared listings stay anonymized. Requires typing DELETE plus the password.
   Add a link in Nav.
2. [FE] Map responses exactly as §13.13.7:
   - `403 reauth_failed` → "Incorrect password";
   - `500` → "Your account still exists — try again";
   - **`401` → treat as already deleted/signed out** (confirmation + route to `/`);
   - `429 kind:'account_reauth'` → "Too many attempts, try again after <retry_after>".
3. [FE] `UsageLimits` panel (reads `/api/account/limits`), once M1.4c is merged.

**Acceptance:**
- Deletion signs the user out and lands on `/` with a confirmation.
- A replayed request after a lost 204 also lands on the confirmation.
- Errors show inline.
- The page uses the §6 tokens only.

### M1.4c Account hardening follow-ups [BE]
Depends on: M1.2 merged and 0007 applied in every environment. Implements §13.13.7
("Re-auth rate limiting", step 2 decision, `GET /api/account/limits`) and §13.14 (test
doubles).
1. [BE] The `account_reauth` kind (limit 10) and the RPC
   `consume_account_reauth_attempt()` ship in 0007 (M1.2, per §13.3.1). Here, add
   `lib/rateLimit.ts#consumeAccountReauthAttempt` and call it in `DELETE /api/account`
   before `deleteAccount` → `429` / `500` per §13.13.7.
2. [BE] Flip `CANCEL_TASKS_FOR_USER_ENABLED`, regenerate `types/database.ts`, move
   the RPC call to `lib/supabase/queries/tasks.ts#cancelQueuedTasksForUser` (typed, no
   cast), and delete `lib/account/cancelUserTasks.ts`.
3. [BE] `GET /api/account/limits` (lists `account_reauth` too).
4. [BE] Move `lib/account/testing/fakeStorage.ts` → `/tests/fakes/supabaseStorage.ts`,
   update imports, and remove the `lib/account/testing/` folder.

**Acceptance:**
- The 11th re-auth attempt in a UTC day returns 429 without calling GoTrue (route
  test asserts no `signInWithPassword` call).
- An RPC failure returns 500 and makes no GoTrue call.
- pgTAP confirms the RPC only ever charges `auth.uid()`.
- Deletion cancels queued tasks.
- Nothing under `lib/` or `app/` imports `/tests/**`.

### M1.5 Job ingestion v2 core [BE]
Implements §13.3.3, 13.6.2, 13.6.4–13.6.7, 13.13.4 (list/detail/write changes).
Depends on: M1.2.
1. [BE] Migration `0009_job_ingestion_v2.sql`: columns and constraints, the
   content_hash trigger, the visibility guard trigger, the RLS rewrite plus revoking
   direct writes, the `create/update/delete_job_listing` RPCs,
   `search_job_descriptions` v2, `job_sources`/`job_source_boards`/`job_source_runs`
   with the seed, `enqueue_source_syncs`, `expire_stale_job_descriptions`,
   `resolve_job_duplicates`, and the ingest/expiry cron jobs.
2. [BE] `lib/jobs/sources/{types,registry,themuse}.ts`, `html.ts`, `normalize.ts`,
   `studentFilter.ts`, and a generic `sync.ts`. Handler `ingest.sync_source` with
   continuation cursors. Handler `maintenance.backfill_job_keys`.
3. [BE] Switch `POST/PATCH/DELETE /api/job-descriptions` to the RPCs (visibility
   accepted, default `shared` for now). Add `?scope=` to GET. Add the v2 fields to
   `toJobDescription`. `GET /api/cron/sync-jobs` now only enqueues. Remove the
   `vercel.json` cron entry.

**Acceptance:**
- A daily run via pg_cron enqueues and completes the Muse sync.
- Existing rows are backfilled (`dedupe_key`, `expires_at`, `content_hash`).
- Expired rows disappear from browse and search but resolve by id.
- Direct PostgREST insert/update on `job_descriptions` as an authenticated user is
  denied.
- All existing job-description route tests are updated and pass.

### M1.6 New sources: USAJOBS, Greenhouse, Lever [BE]
Implements §13.6.1–13.6.3. Depends on: M1.5. USAJOBS part ⛔ Q4 (key). The
Greenhouse/Lever board list needs the user's approval (Q4).
1. [BE] Adapters `usajobs.ts`, `greenhouse.ts`, `lever.ts` with recorded fixtures in
   `tests/fixtures/sources/` and mapper unit tests.
2. [BE] Seed `job_source_boards` with a proposed list of 50–100 intern-hiring
   companies (in a new migration, or via an admin script the orchestrator runs).
   Enable each source once its env and board list are present.
3. [BE] Snapshot-close logic, board auto-disable after 5 failures, and per-source
   throttle plus `Retry-After` handling.

**Acceptance:**
- One full daily cycle ingests from all enabled sources.
- A listing present on both the Muse and Greenhouse appears once, canonical =
  Greenhouse.
- A Greenhouse job removed from its board is closed on the next successful sync, but
  not after a failed one.
- `job_source_runs` shows per-run counts.

### M1.7 Jobs board UI updates [FE]
Implements §13.13.4 (display), §13.6.5/13.6.7 (badges/attribution). Depends on: M1.5.
1. [FE] Add the `SourceAttribution` and `ClosedBadge` components; show apply_url vs
   source_url on cards and detail; hide Apply when closed.
2. [FE] Add a `/jobs/mine` page (`scope=mine`) listing the caller's submissions with
   their visibility and state.

**Acceptance:**
- Muse link-back is preserved.
- Closed and soft-deleted states are visually distinct.
- No hardcoded colors.

### M1.8 QA: Phase 1 gate [QA]
Depends on: M1.4a/b, M1.5, M1.6, M1.7.
1. [QA] pgTAP coverage of §13.3.3: visibility RLS, revoked writes, RPC
   ownership/visibility rules, the shared→private guard, the search scopes, and the
   dedupe resolver.
2. [QA] Adapter fixture tests; dedupe and normalization property tests; a
   sync-continuation idempotency test.
3. [QA] Account deletion end-to-end against the local stack.

**Acceptance:** all green; a list of findings is resolved or explicitly deferred by
the orchestrator.

---

## Phase 2 — Structure

### M2.1 Skills and role-family taxonomy [BE]
Implements §13.3.4, §13.7. Depends on: M1.5, for **migration ordering only** (0010
must apply after 0009). Authoring the JSON data (task 1) can start any time,
including during Phase 1.
1. [BE] Author `data/taxonomy/skills.json` (~400 skills, ~1,200 aliases, covering
   non-tech fields too) and `role-families.json` (~35).
2. [BE] `scripts/taxonomy/build-seed.ts` generates `0011`. Migration `0010_taxonomy.sql`.
3. [BE] `lib/taxonomy/normalize.ts` and `vocabulary.ts` (prompt rendering, cached).
   Add `GET /api/taxonomy/role-families`.

**Acceptance:**
- Alias tests pass (JS/JavaScript, Postgres/PostgreSQL, Node.js, C#, C++, "MS
  Excel"/Excel).
- The generator is deterministic.
- [RV] spot-checks coverage for business, healthcare, and design roles.

### M2.2 Job requirement extraction (batch + sync) [BE]
Implements §13.3.6, 13.5.4(2), 13.6.6 (batch/poll/sync), 13.7.3. Depends on: M2.1,
M1.5, M1.1.
1. [BE] Migration `0013_job_requirements.sql`, including the user-listing extraction
   trigger.
2. [BE] `lib/claude/tasks/extractJobRequirements.ts` (schema, prompt with
   vocabulary, validate) and `lib/claude/batches.ts`.
3. [BE] Handlers `jobs.submit_requirement_batch`, `jobs.poll_requirement_batch`, and
   `jobs.extract_requirements_sync`. Skill mapping with provisional-skill rules.
   Ingest caps and budget.
4. [BE] Add `scripts/taxonomy/review-provisional.ts`.

**Acceptance:**
- The existing corpus is fully extracted through Batches within one day, respecting
  the cap.
- A user-submitted listing gets requirements within ~1–2 min.
- A private listing's unmapped skills create no shared `skills` rows.
- A re-run with an unchanged hash makes zero Claude calls.

### M2.3 Resume profile extraction [BE]
Implements §13.3.5, 13.5.4(1), 13.10.3. Depends on: M2.1, M1.2, M1.1.
1. [BE] Migration `0012_resume_profiles.sql`.
2. [BE] `lib/claude/tasks/extractResumeProfile.ts` with evidence-quote validation.
3. [BE] Handlers `resume.extract_text` and `resume.extract_profile`, callable
   standalone (correlation by resume id) until M3.1 adds reports.

**Acceptance:**
- On 5 synthetic resumes, every stored evidence quote appears verbatim
  (normalized) in the text.
- `not_a_resume` triggers on a non-resume document.
- The same text and prompt version are reused, not re-extracted.

### M2.4 Embeddings ⛔ Q1 [BE]
Implements §13.3.7, 13.8.1, 13.8.2. Depends on: M2.2, M2.3, and the Q1 decision.
1. [BE] Migration `0014_embeddings.sql`: extension, tables, the HNSW index, the
   inactive-listing trigger, and `match_candidates` (service-only, explicit owner
   predicate).
2. [BE] `lib/embeddings/{provider,voyage,text,usage}.ts`. Handlers `jobs.embed_pending`
   and `resume.embed_profile`. Backfill all active listings.
3. [BE] `lib/matching/candidates.ts` wrapper.

**Acceptance:**
- All active listings with fresh requirements have embeddings.
- A closed listing's embedding is deleted.
- `match_candidates` for user B never returns A's private listing (test included).
- The profile embedding text contains no email, phone, URL, or person name
  (asserted by a test with synthetic PII).

### M2.5 Extraction model eval harness [QA + BE]
Implements §13.16 (quality evals), §13.19 Q2. Depends on: M2.2.
1. [QA] Label 50 listings (skills required/preferred, level, role family) in
   `tests/fixtures/listings/labeled/`.
2. [BE] `scripts/evals/extraction.ts`: runs `extractJobRequirements` with model
   overrides (Opus, Sonnet, and Haiku 5.5) and reports skill P/R/F1,
   level/role accuracy, and cost.
3. [QA] Run it and post results for the orchestrator to take to the user (Q2).

**Acceptance:** a results table exists, so the Q2 decision can be made from data.

### M2.6 QA: Phase 2 gate [QA]
Depends on: M2.1–M2.4.
1. [QA] Write pgTAP tests:
   - RLS on profiles, profile skills, requirements, requirement skills, and embeddings
     (server-only)
   - batch item uniqueness
   - provisional-skill creation only from shared external listings
2. [QA] Idempotency tests for every Phase 2 handler (run twice → one output, one
   usage event).

**Acceptance:** all green.

---

## Phase 3 — Core value

### M3.1 Reports schema and pipeline orchestration [BE]
Implements §13.3.8, 13.10, 13.13.1 (upload change), 13.13.2 (GET/retry). Depends on:
M2.3, M2.4.
1. [BE] Migration `0015_reports.sql`: tables, `matches` v2 columns, the RPCs
   `request_resume_report`, `request_fit_check`, `retry_report`, and the refund logic
   hooks.
2. [BE] `advance.ts` (stage machine and fan-in) and `resume.build_matches`. This
   milestone wires the stage chain with critique/rerank/narration as **stub handlers**
   that mark their stages `skipped`, replaced in M3.2–M3.4.
3. [BE] Change `POST /api/resumes` (pre-check, RPC, kick). Add
   `GET /api/resumes/:id/report`, `GET /api/reports/:id` (ETag/304),
   `POST /api/reports/:id/retry`, and `POST /api/resumes/:id/reports`.

**Acceptance:**
- An upload produces a report that reaches `completed` with profile + matching stages
  and visible stage progress.
- Duplicate enqueue is impossible.
- 429 is returned before storage when over the limit.
- A failed report refunds the rate limit for system error codes.

### M3.2 Detailed critique [BE]
Implements §13.5.4(3), 13.5.6 (critique rules). Depends on: M3.1.
1. [BE] `lib/claude/tasks/critiqueResume.ts` (rubric, student guidance,
   fabrication guard) and the `resume.critique` handler, replacing the stub.
2. [BE] Map quotes back to the original text, per §13.13.2 "Displaying quoted text".
   - `semanticValidation.ts#locateQuoteInSource`: NFKC plus invisible-character
     normalization, keeping an offset map back to the original.
   - Store `original_text` as the **original-source span**, never Claude's NFKC quote.
   - Apply the same helper to every quote field: profile evidence (retrofit M2.3 if it
     shipped without it), `evidence_quote`, and fit-check `resume_line` /
     `resume_evidence`.

**Acceptance:**
- On 5 synthetic resumes: exactly 5 dimensions; every `original_text` is verbatim;
  no rewrite introduces an unbracketed number.
- The `dropped_items` count is recorded.
- Fixtures containing `m²`, `™`, `½`, full-width digits, and `ﬁ` produce stored quotes
  identical to the original substrings.

### M3.3 Retrieval scoring and role discovery [BE]
Implements §13.8.3, 13.8.4, 13.8.6 (estimate). Depends on: M3.1.
1. [BE] `lib/matching/{scoring,constants,roleDiscovery}.ts` as pure functions with
   unit tests. Integrate them into `resume.build_matches` (writes `report_roles` and
   `report_job_recommendations`).
2. [BE] Add `GET /api/reports/:id/roles/:slug/jobs` and `/new-matches-count`.

**Acceptance:**
- The formula matches §13.8.4 exactly (table-driven tests).
- At most 2 listings per company per role.
- Roles with fewer than 3 listings are dropped.
- Filters are respected.

### M3.4 Re-rank and role narration (pre-market) [BE]
Implements §13.5.4(4)(5), 13.8.5. Depends on: M3.3.
1. [BE] `rerankJobsForRole.ts` (handle mapping, per-posting isolation) and the
   `resume.rerank_role` handler.
2. [BE] `narrateRoleFit.ts` and the `resume.narrate_roles` handler. Until M4.1, pass
   an empty market and `sufficient_sample=false`. Number-stripping validation applies
   from the start.

**Acceptance:**
- Rerank handles always match the input set exactly.
- Narration contains no digits-with-% (validator test).
- Role `fit_score` = mean of the top-3 assessed scores.

### M3.5 Async fit check [BE]
Implements §13.5.4(6), 13.13.3. Depends on: M3.1 (`request_fit_check`), M2.2 (sync
extraction).
1. [BE] `assessJobFit.ts` and the `match.fit_check` handler (inline extraction when
   stale).
2. [BE] `POST /api/matches` returns 202. `GET /api/matches/:id` and the list routes
   carry status and `details`. Remove the v1 sync path.

**Acceptance:**
- A fit check completes asynchronously.
- An in-flight duplicate returns the same match.
- A soft-deleted listing returns 400, and another user's private listing returns 404.

### M3.6 Report UI (one-step flow) [FE]
Implements §13.4.6, 13.13.2, 13.13.9, 13.14 (`/reports/[id]`, `components/reports`).
Depends on: M3.1. Sections light up as M3.2–M3.4 land (the API returns null sections
until then).
1. [FE] `usePolledResource` hook. The upload form navigates to `/reports/[id]`.
2. [FE] `ReportProgress`/`StageList`, `CritiqueSection` (dimension cards, line
   feedback with original vs rewrite, and a "needs your numbers" marker),
   `RoleCard` with jobs (assessed vs "Estimated match" label), retry button,
   error-code copy, and the delayed-budget notice.
3. [FE] `/resumes/[id]` links to the latest report and offers "Refresh matches".
4. [FE] Quoted resume text (`original_text`, evidence quotes) is displayed and
   highlighted **from the API's original-source strings** (§13.13.2 "Displaying quoted
   text"). Never re-normalize, and never search the resume with an NFKC string.

**Acceptance:**
- A resume containing `m²` / `™` shows those exact characters in line feedback.
- Progress updates without reload.
- Polling stops on terminal states and pauses while the tab is hidden.
- The page is usable at phone width.
- Every error code has copy.

### M3.7 Fit-check UI and v1 UI retirement [FE]
Implements §13.13.3, 13.14 (`/matches/[id]`, `components/fitcheck`). Depends on: M3.5,
M3.6.
1. [FE] `RunMatchForm`/`MatchFromJobForm` handle 202 and navigate to `/matches/[id]`,
   which shows status, `RequirementTable`, `TailoringSuggestions`, and talking points.
2. [FE] Remove `AnalyzeResumeButton`/`AnalysisPanel` usage. The report replaces them.

**Acceptance:**
- No frontend calls to `/analyze` or `/analysis` remain.
- Match history shows status chips for queued, running, and failed checks.

### M3.8 QA: Phase 3 gate [QA]
Depends on: M3.1–M3.7.
1. [QA] Pipeline end-to-end with fake Claude/Voyage against a local DB: happy path,
   each stage failing, retries, lease-expiry recovery, budget snooze, refunds.
2. [QA] Adversarial corpus (§13.16) as unit tests on prompt construction. Also run
   `scripts/evals/injection.ts` once with a real key and report.
3. [QA] Retrieval eval (`scripts/evals/retrieval.ts`, 10 synthetic resumes). Propose
   `SIM_FLOOR`/`SIM_CEIL`/weight calibration to the architect, who updates §13.8.4 if
   it changes.

**Acceptance:**
- All green.
- Calibration recorded in §13.8.4.
- Injection eval shows no score manipulation beyond the agreed band.

### M3.9 v1 cleanup [BE]
Depends on: M3.7.
1. [BE] Delete the `/api/resumes/:id/analyze` and `/analysis` routes,
   `lib/claude/prompts/*`, `lib/claude/parse.ts`, and `lib/claude/rateLimit.ts`. Make
   `resume_analyses` read-only by revoking insert in a new migration. Update tests.

**Acceptance:**
- `tsc`, lint, and tests pass.
- grep finds no references to the removed modules.

---

## Phase 4 — Market fit and custom listings

### M4.1 Market statistics [BE]
Implements §13.3.9, 13.9.1, 13.13.6, 13.8.5 (narration inputs). Depends on: M2.2,
M3.4.
1. [BE] Migration `0016_market_stats.sql` with the MVs, the refresh function, and
   `get_role_market_stats`. Add the `market.refresh_stats` handler and schedule it.
2. [BE] `GET /api/market/roles/:slug`. `resume.narrate_roles` now builds
   `market_snapshot` (level-bucket fallback, `MARKET_MIN_SAMPLE`).

**Acceptance:**
- The stats exclude private and user-submitted listings (pgTAP).
- The report's `market_snapshot` numbers equal the function's output at that time.
- Narration references only the provided slugs.

### M4.2 Market fit UI [FE]
Implements §13.9.1 (grounding/display rules). Depends on: M4.1, M3.6.
1. [FE] Add `RoleMarketFit` to the role card: a skills-demand list with "you have
   this (evidence)" or "gap", a sentence composed from data, Claude comments keyed by
   skill, and the sample size with updated date. Show a "sample too small" state.

**Acceptance:**
- Every number rendered comes from `market_snapshot`.
- No percentages are shown when the sample is insufficient.

### M4.3 Private custom listings (paste) ⛔ Q7 [BE + FE]
Implements §13.2.1(2), 13.11.1, 13.13.4. Depends on: M1.5, M3.5.
1. [BE] Make `visibility` required in `POST /api/job-descriptions` and add
   `fit_check_resume_id`. Finalize PATCH/DELETE visibility semantics in the routes
   (the RPCs already exist).
2. [FE] `/jobs/new` with a paste form, `VisibilityChoice` (explicit, with
   explanatory copy), an optional "check my fit" resume picker, and a confirm dialog
   for private→shared.

**Acceptance:**
- A private listing is invisible to another account (manual and pgTAP), never
  appears in stats, and is matched for its owner.
- A shared→private attempt is rejected with clear copy.

### M4.4 URL import with SSRF protection [BE]
Implements §13.3.10, 13.11.2, 13.11.3. Depends on: M4.3. Deny-list ⛔ Q5 (default
per §13.11.2 until answered).
1. [BE] Migration `0017_listing_imports.sql` and `request_url_import`.
2. [BE] `lib/net/{ipPolicy,safeFetch,extractListingText}.ts` (new deps listed in
   §13.11.3). Handler `import.fetch_listing` (fetch → extract → requirements →
   create listing → optional fit check).
3. [BE] `POST /api/job-descriptions/import-url` and
   `GET /api/job-descriptions/imports/:id`.

**Acceptance:**
- Imports from a real Greenhouse/Lever/company careers page work.
- The full SSRF suite passes: private IPs, IPv6, mapped/NAT64 addresses, redirect to
  internal, DNS rebinding simulation, oversize body, wrong content-type.
- Hidden-element text is absent from the stored description.

### M4.5 Custom listing UI (URL path) [FE]
Implements §13.13.4 (imports), 13.13.9. Depends on: M4.4.
1. [FE] `ImportUrlForm` and `ListingImportStatus` (polling) on `/jobs/new`. Errors
   map to copy, and deny-listed sites suggest the paste flow.

**Acceptance:** after a successful import, the page navigates to the listing and
the fit check if one was requested.

### M4.6 QA: Phase 4 gate [QA]
Depends on: M4.1–M4.5.
1. [QA] An independent SSRF and injection review of `safeFetch`/`extractListingText`,
   with adversarial pages in `tests/fixtures/pages/`.
2. [QA] pgTAP tests for private-listing privacy across every derived table and
   `match_candidates`, and for MV exclusion.

**Acceptance:** all green, with findings resolved.

---

## Phase 5 — Retention

### M5.1 Email provider and weekly digest ⛔ Q6 [BE]
Implements §13.3.11 (prefs/digest_runs), 13.12.1, 13.13.7 (notifications/unsubscribe).
Depends on: M3.3 and the Q6 decision.
1. [BE] Migration `0018_digests_and_revisions.sql` (the digest parts and the weekly
   cron).
2. [BE] `lib/email/{provider,resend}.ts` and the template. Handlers `digest.plan` and
   `digest.send_user` (idempotency key, record before send).
3. [BE] `GET|PUT /api/account/notifications`, plus `GET|POST /api/unsubscribe`
   (one-click). Document the Supabase custom SMTP setup for auth emails.

**Acceptance:**
- A test user with opt-in receives exactly one digest per week, including under
  retries.
- Unsubscribe works without login and doesn't reveal whether a token is valid.
- No resume content appears in the email.

### M5.2 Resume revisions and comparison [BE]
Implements §13.3.11 (`previous_resume_id`), 13.12.2, 13.13.2 (compare). Depends on:
M3.2, M3.4. The migration part shares 0018 with M5.1; if M5.1 hasn't landed, put it
in its own next-numbered migration.
1. [BE] `previous_resume_id` and its trigger. Upload accepts the field. Add
   `GET /api/reports/compare`.

**Acceptance:**
- Resolved and remaining line feedback is computed correctly on fixtures.
- Cross-user ids are rejected.

### M5.3 Retention UI [FE]
Depends on: M5.1, M5.2.
1. [FE] `NotificationPrefs` on `/settings`. A "this is a revision of…" picker on
   upload. `/reports/compare` view (score deltas, resolved feedback, new roles and
   listings).

**Acceptance:** the compare view works for any two of the user's terminal reports.

### M5.4 QA: Phase 5 gate [QA]
Depends on: M5.1–M5.3. Digest idempotency, unsubscribe enumeration resistance, and
deletion completeness including the new tables.

---

## One-line milestone index
| ID | Title | Owner | Depends on | Start now |
|---|---|---|---|---|
| M1.1 | Claude layer v2 foundation (structured outputs, Opus 5.5, delete repair/retry) | BE | — | 🟢 |
| M1.1b | Structured-output `enum` restore (probe + `buildOutputFormat`) | BE | M1.1; before M2.2/M2.3 | |
| M1.2 | Background task infrastructure (0007/0008, worker, kicks) | BE | — | 🟢 |
| M1.3 | QA: task infra and Claude layer (pgTAP harness) | QA | M1.1, M1.2 | |
| M1.4a | Account deletion backend | BE | — | 🟢 |
| M1.4b | Settings page and deletion UI | FE | M1.4a (form); M1.4c (limits panel, 429) | |
| M1.4c | Account hardening: `account_reauth` limit, cancel-tasks gate flip and move, limits endpoint, test-fake move | BE | M1.2 + 0007 applied | |
| M1.5 | Job ingestion v2 core (0009, adapters interface, dedupe, expiry, RPC writes) | BE | M1.2 | |
| M1.6 | USAJOBS, Greenhouse, Lever adapters | BE | M1.5, Q4 | |
| M1.7 | Jobs board UI updates | FE | M1.5 | |
| M1.8 | QA: Phase 1 gate | QA | M1.4–M1.7 | |
| M2.1 | Skills and role-family taxonomy | BE | M1.5 (migration order; data authoring can start now) | |
| M2.2 | Job requirement extraction (batch + sync) | BE | M2.1, M1.5, M1.1, M1.1b | |
| M2.3 | Resume profile extraction | BE | M2.1, M1.2, M1.1, M1.1b | |
| M2.4 | Embeddings and `match_candidates` | BE | M2.2, M2.3, Q1 | |
| M2.5 | Extraction model eval harness | QA+BE | M2.2 | |
| M2.6 | QA: Phase 2 gate | QA | M2.1–M2.4 | |
| M3.1 | Reports schema and pipeline orchestration | BE | M2.3, M2.4 | |
| M3.2 | Detailed critique | BE | M3.1 | |
| M3.3 | Retrieval scoring and role discovery | BE | M3.1 | |
| M3.4 | Re-rank and role narration | BE | M3.3 | |
| M3.5 | Async fit check | BE | M3.1, M2.2 | |
| M3.6 | Report UI (one-step flow) | FE | M3.1 | |
| M3.7 | Fit-check UI and v1 UI retirement | FE | M3.5, M3.6 | |
| M3.8 | QA: Phase 3 gate (e2e, adversarial, calibration) | QA | M3.1–M3.7 | |
| M3.9 | v1 cleanup | BE | M3.7 | |
| M4.1 | Market statistics | BE | M2.2, M3.4 | |
| M4.2 | Market fit UI | FE | M4.1, M3.6 | |
| M4.3 | Private custom listings (paste) | BE+FE | M1.5, M3.5, Q7 | |
| M4.4 | URL import with SSRF protection | BE | M4.3, Q5 | |
| M4.5 | Custom listing UI (URL) | FE | M4.4 | |
| M4.6 | QA: Phase 4 gate | QA | M4.1–M4.5 | |
| M5.1 | Email provider and weekly digest | BE | M3.3, Q6 | |
| M5.2 | Resume revisions and comparison | BE | M3.2, M3.4 | |
| M5.3 | Retention UI | FE | M5.1, M5.2 | |
| M5.4 | QA: Phase 5 gate | QA | M5.1–M5.3 | |
