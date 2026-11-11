# Database tests (pgTAP + concurrency script)

Database-level tests for Kalify's SQL (docs/ARCHITECTURE.md §13.16). They run
against a **local** Supabase stack in Docker, never against the live project.

| What | Where | Runs with |
|---|---|---|
| pgTAP tests (single session, each file in one rolled-back transaction) | `supabase/tests/database/*.test.sql` | `npx supabase test db` |
| Multi-connection concurrency checks (class cap, SKIP LOCKED, atomic rate-limit consume) | `scripts/db-concurrency-check.mjs` | `node scripts/db-concurrency-check.mjs` |

Current coverage (migrations 0007/0008, milestone M1.3):

- `001_claim_tasks` covers `claim_tasks`: validation, class caps (live leases
  of every kind count), ordering, `run_after`, unknown kinds, lease-expiry
  reclaim, and dead-lettering at `max_attempts`.
- `002_task_fencing` covers fencing in `complete_task`, `fail_task`,
  `snooze_task` and `extend_task_lease`. It also checks that snooze doesn't
  use up an attempt, and that `fail_task` sanitizes its inputs.
- `003_enqueue_dedupe_housekeeping` covers `enqueue_task` idempotency and the
  partial unique index on live `dedupe_key`s, plus `defer_queued_tasks`,
  `cancel_tasks_for_user`, the `dead_letter_stale_tasks` threshold guard, and
  `purge_finished_tasks`.
- `004_dead_task_hooks` covers the dead-task hook outbox: claim, complete and
  release fencing.
- `005_rate_limits` covers:
  - `consume_rate_limit`;
  - `consume_account_reauth_attempt`, which charges only `auth.uid()` and
    returns false on the 11th call in a UTC day;
  - `get_my_rate_limits`.
- `006_privileges_rls` covers:
  - EXECUTE revoked on every service function, and `invoke_worker_tick` not
    executable even by `service_role`;
  - `search_path` / `SECURITY DEFINER` hardening;
  - RLS and table privileges on the new tables.

## One-time setup (Windows)

1. Install **Docker Desktop** and start it. It needs WSL 2 / the Windows
   hypervisor enabled. Check with `docker version`: both Client and Server
   must print.
2. **Git Bash PATH note:** Docker Desktop's installer adds `docker` to the
   Windows PATH, but an already-open Git Bash (or one launched by a tool)
   may not see it. If `docker` is "command not found", prefix commands with:

   ```bash
   export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"
   ```

   PowerShell and cmd normally pick it up after a restart.
3. `npm install`. The Supabase CLI (`supabase`), `pg` and `pg-connection-string` are pinned
   devDependencies, so `npx supabase` uses the project's version. Don't use
   `npx supabase@latest`.

## Running

From the repo root:

```bash
# Start the local stack. The first run pulls ~2 GB of images. It applies
# supabase/migrations/0001..NNNN to a fresh local database, which also proves
# the migrations replay cleanly from scratch.
npx supabase start

# pgTAP: runs every file under supabase/tests/ with pg_prove.
npx supabase test db

# Concurrency checks: uses the local DB URL by default
# (postgresql://postgres:postgres@127.0.0.1:54322/postgres, as shown by
# `npx supabase status`). It refuses any host other than 127.0.0.1 or
# localhost (including via a `?host=` query parameter) and any port other
# than the local DB port in supabase/config.toml.
node scripts/db-concurrency-check.mjs
```

> **Never pass `--remote` to `supabase test db`**, and **never run
> `supabase link` in this repo.** Either one points the CLI at the live
> project. The pgTAP files delete rows (for example, `delete from
> public.background_tasks`) and assume a disposable database. They run inside
> a rolled-back transaction, but they must still only ever run locally.

Other useful commands:

- `npx supabase status` shows URLs and keys for the running stack.
- `npx supabase db reset` re-applies all migrations from scratch. It wipes
  local data.
- `npx supabase stop` stops the stack. Data is kept in Docker volumes.

## Writing new pgTAP tests

- One file per area, named `NNN_area.test.sql`, under `supabase/tests/database/`.
- Wrap each file in `begin; ... select * from finish(); rollback;`. Start with
  `create extension if not exists pgtap with schema extensions;` and
  `select plan(N);`. N must equal the number of assertions, and a multi-row
  `select ok(...) from ...` counts once per row.
- Fully qualify every name (`public.`, `private.`, `auth.`).
- Simulate an API user the way PostgREST does:

  ```sql
  set local role authenticated;
  select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true);
  select set_config('request.jwt.claim.sub', '<uuid>', true);
  -- ... assertions ...
  reset role;
  ```

  Users are created with `insert into auth.users (id, email) values (...)`. The
  transaction rolls them back.
- When you call a function that mutates rows, check its effect in a **separate
  statement**. A subquery in the same statement reads the pre-update snapshot.
- Anything that needs two sessions (locks, races) belongs in
  `scripts/db-concurrency-check.mjs`, not pgTAP.
