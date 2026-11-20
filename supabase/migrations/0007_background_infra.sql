-- Kalify v2 — background task infrastructure (milestone M1.2).
--
-- Implements docs/ARCHITECTURE.md §13.3.1 exactly:
--   * the `private` schema (not exposed by PostgREST)
--   * public.background_tasks      (server-only)
--   * public.ai_usage_events       (server-only)
--   * public.rate_limit_events     (owner-select only)
--   * private.rate_limits          (config, seeded)
--   * task functions: enqueue_task, claim_tasks, complete_task, fail_task,
--     snooze_task, extend_task_lease, cancel_tasks_for_user,
--     purge_finished_tasks                      (service_role only)
--   * housekeeping / budget helpers: dead_letter_stale_tasks,
--     defer_queued_tasks                        (service_role only)
--   * dead-task hook outbox: claim_dead_task_hooks,
--     complete_dead_task_hook, release_dead_task_hook (service_role only)
--   * private.consume_rate_limit               (service_role only)
--   * public.get_my_rate_limits                (authenticated user RPC)
--   * public.consume_account_reauth_attempt    (authenticated user RPC)
-- plus two read-only, service_role-only aggregate helpers the worker needs
-- (see the note above them for why they exist):
--   * public.ai_spend_summary, public.background_task_counts
--
-- Conventions (§13.3):
--   * Every function: `set search_path = ''` and fully qualified names.
--     (pg_catalog is always searched implicitly, so built-ins such as now(),
--     count(), hashtext(), gen_random_uuid() resolve without qualification.)
--   * Every function not meant for end users:
--       revoke execute ... from public, anon, authenticated;
--       grant execute ... to service_role;
--     Postgres grants EXECUTE to PUBLIC by default, and Supabase's default
--     privileges additionally grant it to anon/authenticated explicitly, so
--     all three revokes are required.
--   * Server-only tables: RLS on, no policies, and table privileges revoked
--     from anon/authenticated (Supabase's default privileges grant them).
--   * Owner-only tables: exactly one `for select to authenticated` policy.
--
-- Forward-only. Never edit after it has been applied; add a new migration.

-- ---------------------------------------------------------------------
-- private schema
-- ---------------------------------------------------------------------

create schema if not exists private;

comment on schema private is
  'Kalify internal schema (docs/ARCHITECTURE.md §13.3): config tables, materialized views and internal helpers. Not exposed by PostgREST; never add it to the API''s exposed schemas.';

revoke all on schema private from public, anon, authenticated;
-- service_role gets USAGE only so the explicit EXECUTE grants on private
-- functions below are meaningful. It gets no table privileges here.
grant usage on schema private to service_role;

-- Default privileges for objects created later in `private` (by the role
-- running migrations). Defense in depth only, and limited by Postgres
-- semantics: per-schema default privileges can ADD to, but never remove,
-- the global defaults. In particular Postgres's built-in global default
-- "EXECUTE on functions to PUBLIC" is NOT removed by the functions line
-- below, so every private function still needs (and gets) an explicit
-- `revoke execute ... from public, anon, authenticated`. These lines do
-- remove any schema-scoped default grants that may exist for `private`.
alter default privileges in schema private revoke all on tables from public, anon, authenticated;
alter default privileges in schema private revoke all on sequences from public, anon, authenticated;
alter default privileges in schema private revoke all on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Advisory lock namespaces (two-key pg_advisory_xact_lock(int4, int4)):
--   410701  claim_tasks, keyed by hashtext(task_class)
--   410702  private.consume_rate_limit, keyed by hashtext(user_id || ':' || kind)
-- (§13.3.1 calls these NS_CLAIM and NS_RATE_LIMIT.) Any future lock user
-- must add its own namespace constant here.
-- Distinct first keys keep the two lock families from ever colliding.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- background_tasks (server-only)
-- ---------------------------------------------------------------------

create table public.background_tasks (
  id uuid primary key default gen_random_uuid(),
  -- No check constraint on `kind`: kinds grow with code, and the worker only
  -- claims kinds in its own registry (lib/tasks/registry.ts, §13.4.3).
  kind text not null
    check (char_length(kind) between 1 and 100),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'dead', 'cancelled')),
  priority smallint not null default 0,
  task_class text not null
    check (task_class in ('user', 'background')),
  -- Set server-side at enqueue, never from client input.
  user_id uuid references auth.users(id) on delete cascade,
  correlation_id uuid,
  parent_task_id uuid references public.background_tasks(id) on delete set null,
  -- Ids and small enums only — never resume/job text or any PII. The type
  -- and size checks are a backstop for that rule, not a substitute for it.
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4096),
  dedupe_key text
    check (dedupe_key is null or char_length(dedupe_key) between 1 and 300),
  attempts integer not null default 0
    check (attempts >= 0),
  max_attempts integer not null
    check (max_attempts >= 1),
  run_after timestamptz not null default now(),
  lease_seconds integer not null
    check (lease_seconds > 0),
  -- Worker invocation id; the fencing token for complete/fail/snooze/extend.
  locked_by text,
  locked_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  -- Machine code from lib/tasks/errors.ts (§13.4.5).
  last_error_code text
    check (last_error_code is null or char_length(last_error_code) <= 64),
  -- Sanitized, <= 500 chars, never PII.
  last_error_message text
    check (last_error_message is null or char_length(last_error_message) <= 500),
  -- Small summary (counts, ids).
  result jsonb,
  -- Dead-task hook outbox (§13.4.5): a `dead` row's onDead hook is delivered
  -- at least once by the worker via claim_dead_task_hooks /
  -- complete_dead_task_hook, whichever path (TS or SQL) killed the task.
  on_dead_handled_at timestamptz,
  on_dead_attempts integer not null default 0
    check (on_dead_attempts >= 0),
  on_dead_locked_by text,
  on_dead_locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.background_tasks is
  'Postgres task queue drained by POST /api/worker/tick (docs/ARCHITECTURE.md §13.3.1, §13.4). Server-only: RLS on, no policies; only service_role touches it. payload holds ids/small enums only — never resume/job text or PII.';

-- At most one live task per dedupe key (§13.4.4 rule 1). enqueue_task uses
-- `on conflict (dedupe_key) where status in ('queued','running') do nothing`.
create unique index background_tasks_dedupe_key_live_uidx
  on public.background_tasks (dedupe_key)
  where status in ('queued', 'running');

create index background_tasks_claim_idx
  on public.background_tasks (task_class, priority desc, run_after)
  where status = 'queued';

create index background_tasks_locked_until_idx
  on public.background_tasks (locked_until)
  where status = 'running';

create index background_tasks_correlation_id_idx
  on public.background_tasks (correlation_id);

create index background_tasks_user_id_idx
  on public.background_tasks (user_id);

create index background_tasks_finished_at_idx
  on public.background_tasks (finished_at)
  where status in ('succeeded', 'dead', 'cancelled');

-- Supports the `on delete set null` from child tasks without a seq scan.
create index background_tasks_parent_task_id_idx
  on public.background_tasks (parent_task_id);

-- Dead-task hook sweep (§13.4.5): pending hooks in finished_at order.
create index background_tasks_on_dead_pending_idx
  on public.background_tasks (finished_at)
  where status = 'dead' and on_dead_handled_at is null;

create trigger background_tasks_set_updated_at
  before update on public.background_tasks
  for each row
  execute function public.set_updated_at();

alter table public.background_tasks enable row level security;
-- Server-only: deliberately no policies.
revoke all on table public.background_tasks from anon, authenticated;

-- ---------------------------------------------------------------------
-- ai_usage_events (server-only)
-- ---------------------------------------------------------------------

create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  -- on delete SET NULL (not cascade): keeps spend accounting after account
  -- deletion. The row holds no PII.
  user_id uuid references auth.users(id) on delete set null,
  task_id uuid references public.background_tasks(id) on delete set null,
  task_attempt integer
    check (task_attempt is null or task_attempt >= 0),
  provider text not null
    check (provider in ('anthropic', 'voyage')),
  -- Claude task name (`critique`, ...) or `embed`.
  operation text not null
    check (char_length(operation) between 1 and 100),
  -- The ACTUAL response.model (may differ from the requested model when the
  -- server-side fallback fires).
  model text not null
    check (char_length(model) between 1 and 200),
  is_batch boolean not null default false,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  cost_usd numeric(12, 6) not null check (cost_usd >= 0),
  stop_reason text
    check (stop_reason is null or char_length(stop_reason) <= 100),
  request_id text
    check (request_id is null or char_length(request_id) <= 200),
  created_at timestamptz not null default now()
);

comment on table public.ai_usage_events is
  'One row per external AI API call actually made, including calls that failed after tokens were billed (docs/ARCHITECTURE.md §13.3.1, §13.9.4). Server-only. Never holds prompt/response content or PII.';

create index ai_usage_events_created_at_idx
  on public.ai_usage_events (created_at);

create index ai_usage_events_user_id_created_at_idx
  on public.ai_usage_events (user_id, created_at);

-- Supports the `on delete set null` from background_tasks purges.
create index ai_usage_events_task_id_idx
  on public.ai_usage_events (task_id);

alter table public.ai_usage_events enable row level security;
-- Server-only: deliberately no policies.
revoke all on table public.ai_usage_events from anon, authenticated;

-- ---------------------------------------------------------------------
-- rate_limit_events (owner-select only)
-- ---------------------------------------------------------------------

create table public.rate_limit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null
    check (kind in (
      'resume_report',
      'refresh_matches',
      'fit_check',
      'url_import',
      'job_listing_create',
      'job_listing_update',
      'account_reauth'
    )),
  -- Report / match / import / listing id.
  ref_id uuid,
  -- Set when the action failed for system reasons (§13.10.4); refunded rows
  -- do not count toward the limit.
  refunded_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.rate_limit_events is
  'Per-user daily rate-limit ledger (docs/ARCHITECTURE.md §13.3.1, §13.9.3). Owner-select only; rows are inserted only by security-definer RPCs via private.consume_rate_limit and refunded by the worker (service_role).';

create index rate_limit_events_user_kind_created_at_idx
  on public.rate_limit_events (user_id, kind, created_at desc);

-- Refunds look rows up by ref_id (§13.10.4).
create index rate_limit_events_ref_id_idx
  on public.rate_limit_events (ref_id)
  where ref_id is not null;

alter table public.rate_limit_events enable row level security;

create policy "rate_limit_events_select_own" on public.rate_limit_events
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Owner-only table: users may only SELECT (and RLS narrows that to their
-- own rows). No insert/update/delete privileges, so even a future
-- accidentally-permissive policy could not open writes.
revoke all on table public.rate_limit_events from anon, authenticated;
grant select on table public.rate_limit_events to authenticated;

-- ---------------------------------------------------------------------
-- private.rate_limits (config)
-- ---------------------------------------------------------------------

-- Limits live in SQL because RPCs enforce them; a limit passed in as an
-- argument could be forged by a direct PostgREST call (§13.3.1).
create table private.rate_limits (
  kind text primary key,
  daily_limit integer not null check (daily_limit >= 0)
);

comment on table private.rate_limits is
  'Per-user daily limits by action kind, enforced by private.consume_rate_limit (docs/ARCHITECTURE.md §13.3.1). Product numbers pending user confirmation (§13.19 Q3).';

alter table private.rate_limits enable row level security;
-- Not reachable through PostgREST (private schema), and no role but the
-- owner has privileges; RLS is enabled anyway per "RLS on every table".
revoke all on table private.rate_limits from public, anon, authenticated, service_role;

insert into private.rate_limits (kind, daily_limit) values
  ('resume_report', 5),
  ('refresh_matches', 5),
  ('fit_check', 20),
  ('url_import', 20),
  ('job_listing_create', 20),
  ('job_listing_update', 40),
  -- Every password re-auth attempt per user per UTC day (§13.13.7).
  ('account_reauth', 10);

-- ---------------------------------------------------------------------
-- Task functions (service_role only)
-- ---------------------------------------------------------------------
-- All are SECURITY INVOKER: their only callers are service_role (via the
-- worker / admin client), pg_cron jobs (run as postgres) and future
-- security-definer RPCs (run as their owner), all of which already hold the
-- needed table privileges. Nothing here needs elevated rights.

-- enqueue_task --------------------------------------------------------
-- Idempotent on dedupe_key: if a live (queued/running) task with the same
-- key exists, returns that task's id instead of inserting.
-- Defaults exist so tasks can be enqueued from SQL by name (e.g.
-- `select public.enqueue_task(p_kind => 'maintenance.noop', p_task_class => 'background');`).
-- The TS enqueue path (lib/tasks/enqueue.ts) always passes the registry's
-- priority/max_attempts/lease_seconds explicitly. The lease default (300 s)
-- exceeds every registry kind's maxDurationMs + 30 s.
create function public.enqueue_task(
  p_kind text,
  p_task_class text,
  p_payload jsonb default '{}'::jsonb,
  p_user_id uuid default null,
  p_dedupe_key text default null,
  p_priority integer default 0,
  p_max_attempts integer default 3,
  p_lease_seconds integer default 300,
  p_run_after timestamptz default null,
  p_correlation_id uuid default null,
  p_parent_task_id uuid default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_try integer := 0;
begin
  if p_kind is null or char_length(p_kind) = 0 then
    raise exception 'validation_kind_required';
  end if;

  loop
    v_try := v_try + 1;

    insert into public.background_tasks (
      kind, task_class, payload, user_id, dedupe_key, priority,
      max_attempts, lease_seconds, run_after, correlation_id, parent_task_id
    ) values (
      p_kind,
      p_task_class,
      coalesce(p_payload, '{}'::jsonb),
      p_user_id,
      p_dedupe_key,
      coalesce(p_priority, 0),
      coalesce(p_max_attempts, 3),
      coalesce(p_lease_seconds, 300),
      coalesce(p_run_after, now()),
      p_correlation_id,
      p_parent_task_id
    )
    on conflict (dedupe_key) where status in ('queued', 'running')
    do nothing
    returning id into v_id;

    if v_id is not null then
      return v_id;
    end if;

    -- Conflict: return the existing live task for this key.
    select t.id into v_id
    from public.background_tasks t
    where t.dedupe_key = p_dedupe_key
      and t.status in ('queued', 'running')
    limit 1;

    if v_id is not null then
      return v_id;
    end if;

    -- The conflicting task finished between our insert and select; the key
    -- is free again, so retry the insert. Bounded to avoid any livelock.
    if v_try >= 3 then
      raise exception 'conflict_enqueue_retry_exhausted';
    end if;
  end loop;
end;
$$;

comment on function public.enqueue_task is
  'Enqueue a background task (docs/ARCHITECTURE.md §13.3.1). Idempotent on dedupe_key while a task with that key is queued/running: returns the existing task id. service_role only.';

-- dead_letter_stale_tasks ---------------------------------------------
-- Stale-lease housekeeping (§13.3.1): dead-letters ANY `running` task whose
-- lease expired more than p_older_than ago (default 6 hours), regardless of
-- kind or attempts, with code `lease_expired`.
--
-- Why: claim_tasks only reclaims / dead-letters expired leases of kinds the
-- calling worker knows (p_kinds). A task whose kind was later removed or
-- renamed, or that only a preview deployment knew, would otherwise stay
-- `running` forever once its worker died, and keep blocking its dedupe key.
-- Six hours is far beyond any lease (max 300 s) plus cron cadence, so any
-- deployment that knows the kind has long had the chance to reclaim it.
-- The distinct last_error_message tells these apart from final-attempt
-- expiries in claim_tasks. Rows dead-lettered here enter the dead-task hook
-- outbox like any other dead task. Scheduled hourly by pg_cron (0008,
-- `kalify-stale-leases`). Returns the number of tasks dead-lettered.
create function public.dead_letter_stale_tasks(
  p_older_than interval default interval '6 hours'
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_older_than is null or p_older_than < interval '10 minutes' then
    -- Guard against dead-lettering live work with a tiny threshold.
    raise exception 'validation_older_than_too_small';
  end if;

  with stale as (
    select t.id
    from public.background_tasks t
    where t.status = 'running'
      and t.locked_until <= v_now - p_older_than
    for update skip locked
  )
  update public.background_tasks t
     set status = 'dead',
         last_error_code = 'lease_expired',
         last_error_message = 'Lease expired long ago and no deployment reclaimed it (stale-lease sweep; kind may be unregistered).',
         locked_until = null,
         finished_at = v_now
    from stale x
   where t.id = x.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.dead_letter_stale_tasks is
  'Stale-lease sweep (docs/ARCHITECTURE.md §13.3.1): dead-letter running tasks of any kind whose lease expired more than p_older_than ago (default 6 h), code lease_expired. Scheduled hourly (kalify-stale-leases). service_role only.';

-- claim_tasks ---------------------------------------------------------
-- 1. Serialize claimers per class with an advisory xact lock so the
--    concurrency cap is global across concurrent worker invocations.
-- 2. Dead-letter expired leases already at max_attempts (lease_expired).
--    (Stale leases of kinds no worker knows: dead_letter_stale_tasks.)
-- 3. running_now = live leases in the class (all kinds).
-- 4. Claim least(p_limit, p_max_running - running_now) claimable rows of
--    p_kinds, priority desc, run_after asc, FOR UPDATE SKIP LOCKED.
create function public.claim_tasks(
  p_worker_id text,
  p_task_class text,
  p_kinds text[],
  p_max_running integer,
  p_limit integer
)
returns setof public.background_tasks
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_running integer;
  v_slots integer;
begin
  if p_worker_id is null or char_length(p_worker_id) = 0 then
    raise exception 'validation_worker_id_required';
  end if;
  if p_task_class is null or p_task_class not in ('user', 'background') then
    raise exception 'validation_task_class_invalid';
  end if;
  if p_kinds is null or cardinality(p_kinds) = 0
     or p_limit is null or p_limit <= 0
     or p_max_running is null or p_max_running <= 0 then
    return;
  end if;

  perform pg_advisory_xact_lock(410701, hashtext(p_task_class));

  -- Read the clock after acquiring the lock so a claimer that waited sees
  -- the leases the previous holder just committed as live.
  v_now := clock_timestamp();

  with expired as (
    select t.id
    from public.background_tasks t
    where t.task_class = p_task_class
      and t.kind = any(p_kinds)
      and t.status = 'running'
      and t.locked_until <= v_now
      and t.attempts >= t.max_attempts
    for update skip locked
  )
  update public.background_tasks t
     set status = 'dead',
         last_error_code = 'lease_expired',
         last_error_message = 'Lease expired on the final attempt (worker stopped before finishing).',
         locked_until = null,
         finished_at = v_now
    from expired e
   where t.id = e.id;

  select count(*)::integer into v_running
  from public.background_tasks t
  where t.task_class = p_task_class
    and t.status = 'running'
    and t.locked_until > v_now;

  v_slots := least(p_limit, p_max_running - v_running);
  if v_slots <= 0 then
    return;
  end if;

  return query
  with candidates as (
    select t.id
    from public.background_tasks t
    where t.task_class = p_task_class
      and t.kind = any(p_kinds)
      and (
        (t.status = 'queued' and t.run_after <= v_now)
        or (t.status = 'running' and t.locked_until <= v_now
            and t.attempts < t.max_attempts)
      )
    order by t.priority desc, t.run_after asc
    limit v_slots
    for update skip locked
  ),
  claimed as (
    update public.background_tasks t
       set status = 'running',
           attempts = t.attempts + 1,
           locked_by = p_worker_id,
           locked_until = v_now + make_interval(secs => t.lease_seconds),
           started_at = coalesce(t.started_at, v_now)
      from candidates c
     where t.id = c.id
    returning t.*
  )
  select * from claimed;
end;
$$;

comment on function public.claim_tasks is
  'Claim up to least(p_limit, p_max_running - live leases in class) tasks of the given kinds for worker p_worker_id (docs/ARCHITECTURE.md §13.3.1). Reclaims expired leases; dead-letters expired leases at max_attempts with lease_expired. service_role only.';

-- complete_task -------------------------------------------------------
-- Fenced: no-op (returns false) unless this worker still holds the task.
create function public.complete_task(
  p_id uuid,
  p_worker_id text,
  p_result jsonb default null
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  update public.background_tasks t
     set status = 'succeeded',
         result = p_result,
         locked_until = null,
         finished_at = clock_timestamp()
   where t.id = p_id
     and t.locked_by = p_worker_id
     and t.status = 'running';

  return found;
end;
$$;

comment on function public.complete_task is
  'Mark a running task succeeded. Fenced on locked_by = p_worker_id and status = running; returns false (no-op) otherwise. service_role only.';

-- fail_task -----------------------------------------------------------
-- Fenced. Retryable and attempts < max_attempts -> 'queued' with backoff;
-- otherwise 'dead'. Returns the new status, or NULL when fenced out (this
-- worker no longer holds the task, so nothing was changed).
create function public.fail_task(
  p_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_retryable boolean,
  p_retry_delay_seconds integer
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
  v_now timestamptz := clock_timestamp();
  v_code text;
  v_message text;
  v_status text;
begin
  select t.attempts, t.max_attempts
    into v_attempts, v_max_attempts
  from public.background_tasks t
  where t.id = p_id
    and t.locked_by = p_worker_id
    and t.status = 'running'
  for update;

  if not found then
    return null;
  end if;

  -- Defense in depth: lib/tasks/errors.ts already sanitizes these.
  v_code := case
    when p_error_code ~ '^[a-z][a-z0-9_]{0,63}$' then p_error_code
    else 'internal_error'
  end;
  v_message := nullif(
    left(regexp_replace(coalesce(p_error_message, ''), '[[:cntrl:]]+', ' ', 'g'), 500),
    ''
  );

  if coalesce(p_retryable, false) and v_attempts < v_max_attempts then
    v_status := 'queued';
    update public.background_tasks t
       set status = 'queued',
           run_after = v_now + make_interval(secs => greatest(coalesce(p_retry_delay_seconds, 0), 0)),
           locked_by = null,
           locked_until = null,
           last_error_code = v_code,
           last_error_message = v_message
     where t.id = p_id;
  else
    v_status := 'dead';
    update public.background_tasks t
       set status = 'dead',
           locked_until = null,
           finished_at = v_now,
           last_error_code = v_code,
           last_error_message = v_message
     where t.id = p_id;
  end if;

  return v_status;
end;
$$;

comment on function public.fail_task is
  'Record a failed attempt. Fenced on locked_by/status. Requeues with run_after = now() + delay when retryable and attempts < max_attempts, else dead. Returns the new status, or NULL when fenced out. service_role only.';

-- snooze_task ---------------------------------------------------------
-- Re-queue a task THAT IS RUNNING without consuming an attempt (attempts - 1
-- undoes the claim's increment). For "batch not ready yet" and for a
-- handler that hits a budget mid-run. (The worker's global-budget deferral
-- of not-yet-started tasks uses defer_queued_tasks instead and never claims.)
-- p_reason is a machine code (e.g. 'batch_not_ready'). It is stored in
-- last_error_code only when that is empty: a previous attempt's real error
-- code is preserved, because the worker's "ai_invalid_output: one more try,
-- then dead" rule reads the previous attempt's code. started_at is kept: the
-- task did start. Fenced; returns false when this worker no longer holds
-- the task.
create function public.snooze_task(
  p_id uuid,
  p_worker_id text,
  p_seconds integer,
  p_reason text
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  update public.background_tasks t
     set status = 'queued',
         attempts = greatest(t.attempts - 1, 0),
         run_after = clock_timestamp() + make_interval(secs => greatest(coalesce(p_seconds, 0), 0)),
         locked_by = null,
         locked_until = null,
         last_error_code = coalesce(
           t.last_error_code,
           case
             when p_reason ~ '^[a-z][a-z0-9_]{0,63}$' then p_reason
             else 'snoozed'
           end
         )
   where t.id = p_id
     and t.locked_by = p_worker_id
     and t.status = 'running';

  return found;
end;
$$;

comment on function public.snooze_task is
  'Re-queue a running task after p_seconds without consuming an attempt; keeps a prior last_error_code. Fenced; returns false when fenced out. service_role only.';

-- defer_queued_tasks --------------------------------------------------
-- Global AI budget (§13.9.4): pushes CLAIMABLE queued tasks of p_kinds in
-- p_task_class to p_until plus a per-task random 0..p_max_jitter_seconds,
-- WITHOUT claiming them. Nothing else changes: attempts, started_at,
-- locks and last_error_code are untouched, so a deferral can never consume
-- an attempt, never marks a task as started, and never disturbs retry
-- tracking. Bounded by p_limit per call (the next tick continues).
-- Returns the deferred rows (post-update) so the worker can run the kind's
-- idempotent onBudgetDelayed hook (e.g. set resume_reports.notice).
create function public.defer_queued_tasks(
  p_task_class text,
  p_kinds text[],
  p_until timestamptz,
  p_max_jitter_seconds integer default 900,
  p_limit integer default 200
)
returns setof public.background_tasks
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_task_class is null or p_task_class not in ('user', 'background') then
    raise exception 'validation_task_class_invalid';
  end if;
  if p_until is null then
    raise exception 'validation_until_required';
  end if;
  if p_kinds is null or cardinality(p_kinds) = 0 or coalesce(p_limit, 0) <= 0 then
    return;
  end if;

  return query
  with due as (
    select t.id
    from public.background_tasks t
    where t.task_class = p_task_class
      and t.kind = any(p_kinds)
      and t.status = 'queued'
      and t.run_after <= v_now
    order by t.priority desc, t.run_after asc
    limit p_limit
    for update skip locked
  ),
  deferred as (
    update public.background_tasks t
       set run_after = greatest(p_until, v_now)
             + make_interval(secs => floor(random() * (greatest(coalesce(p_max_jitter_seconds, 0), 0) + 1)))
      from due d
     where t.id = d.id
    returning t.*
  )
  select * from deferred;
end;
$$;

comment on function public.defer_queued_tasks is
  'Global AI budget deferral (docs/ARCHITECTURE.md §13.9.4): move claimable queued tasks of p_kinds to p_until + jitter without claiming them (no attempt used, started_at/last_error_code untouched). Returns the deferred rows. service_role only.';

-- extend_task_lease ---------------------------------------------------
-- Heartbeat for long tasks. Never shortens an existing lease.
create function public.extend_task_lease(
  p_id uuid,
  p_worker_id text,
  p_seconds integer
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_seconds is null or p_seconds <= 0 then
    raise exception 'validation_seconds_positive';
  end if;

  update public.background_tasks t
     set locked_until = greatest(
           t.locked_until,
           clock_timestamp() + make_interval(secs => p_seconds)
         )
   where t.id = p_id
     and t.locked_by = p_worker_id
     and t.status = 'running';

  return found;
end;
$$;

comment on function public.extend_task_lease is
  'Extend a running task''s lease to at least now() + p_seconds. Fenced; returns false when fenced out. service_role only.';

-- cancel_tasks_for_user -----------------------------------------------
-- Account deletion (§13.13.7): cancel the user's queued tasks. Running
-- tasks are left to finish/fail on their own (their handlers assert
-- ownership against rows that are about to cascade away); the auth.users
-- delete then cascades every background_tasks row for the user anyway.
create function public.cancel_tasks_for_user(p_user_id uuid)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_user_id is null then
    raise exception 'validation_user_id_required';
  end if;

  update public.background_tasks t
     set status = 'cancelled',
         finished_at = clock_timestamp(),
         locked_until = null
   where t.user_id = p_user_id
     and t.status = 'queued';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.cancel_tasks_for_user is
  'Cancel every queued task belonging to p_user_id (account deletion). Returns the number cancelled. service_role only.';

-- purge_finished_tasks ------------------------------------------------
-- Daily housekeeping (pg_cron, migration 0008). Dead rows are deleted only
-- once their onDead hook has been handled (§13.4.5); unhandled ones are kept
-- and surface as dead_hooks_pending in GET /api/worker/status.
-- Returns the number of rows deleted.
create function public.purge_finished_tasks()
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.background_tasks t
   where (t.status in ('succeeded', 'cancelled')
          and t.finished_at < now() - interval '14 days')
      or (t.status = 'dead'
          and t.on_dead_handled_at is not null
          and t.finished_at < now() - interval '30 days');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.purge_finished_tasks is
  'Delete succeeded/cancelled tasks finished > 14 days ago and dead tasks finished > 30 days ago whose onDead hook was handled. Returns rows deleted. service_role only (scheduled by pg_cron).';

-- ---------------------------------------------------------------------
-- Dead-task hook outbox (service_role only), §13.4.5
-- ---------------------------------------------------------------------
-- Tasks can go `dead` in SQL with no TS running (claim_tasks lease_expired,
-- dead_letter_stale_tasks), so onDead is delivered from the row itself:
-- every dead row starts with on_dead_handled_at null, and the worker claims
-- and completes hooks here. Delivery is at-least-once; hooks are idempotent.

-- claim_dead_task_hooks -------------------------------------------------
-- Locks up to p_limit pending hooks (dead, unhandled, kind known to the
-- caller, hook lock free or expired) for 120 s and increments
-- on_dead_attempts. With p_task_id, only that row is considered (the
-- worker's fast path right after its own fail_task returned 'dead').
create function public.claim_dead_task_hooks(
  p_worker_id text,
  p_kinds text[],
  p_limit integer,
  p_task_id uuid default null
)
returns setof public.background_tasks
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_id is null or char_length(p_worker_id) = 0 then
    raise exception 'validation_worker_id_required';
  end if;
  if p_kinds is null or cardinality(p_kinds) = 0 or coalesce(p_limit, 0) <= 0 then
    return;
  end if;

  return query
  with pending as (
    select t.id
    from public.background_tasks t
    where t.status = 'dead'
      and t.on_dead_handled_at is null
      and t.kind = any(p_kinds)
      and (t.on_dead_locked_until is null or t.on_dead_locked_until <= v_now)
      and (p_task_id is null or t.id = p_task_id)
    order by t.finished_at asc nulls first
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.background_tasks t
       set on_dead_locked_by = p_worker_id,
           on_dead_locked_until = v_now + interval '120 seconds',
           on_dead_attempts = t.on_dead_attempts + 1
      from pending x
     where t.id = x.id
    returning t.*
  )
  select * from claimed;
end;
$$;

comment on function public.claim_dead_task_hooks is
  'Dead-task hook outbox (docs/ARCHITECTURE.md §13.4.5): lock up to p_limit pending onDead hooks of known kinds for 120 s (optionally one task), incrementing on_dead_attempts. service_role only.';

-- complete_dead_task_hook ------------------------------------------------
-- Fenced on on_dead_locked_by. Marks the hook handled and clears its lock.
-- p_gave_up additionally records a no-PII note in last_error_message
-- (last_error_code keeps the original failure code).
create function public.complete_dead_task_hook(
  p_id uuid,
  p_worker_id text,
  p_gave_up boolean default false
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  update public.background_tasks t
     set on_dead_handled_at = clock_timestamp(),
         on_dead_locked_by = null,
         on_dead_locked_until = null,
         last_error_message = case
           when coalesce(p_gave_up, false)
             then 'onDead hook gave up after ' || t.on_dead_attempts || ' attempts'
           else t.last_error_message
         end
   where t.id = p_id
     and t.status = 'dead'
     and t.on_dead_handled_at is null
     and t.on_dead_locked_by = p_worker_id;

  return found;
end;
$$;

comment on function public.complete_dead_task_hook is
  'Mark a dead task''s onDead hook handled (fenced on on_dead_locked_by). p_gave_up records a no-PII note in last_error_message. Returns false when fenced out or already handled. service_role only.';

-- release_dead_task_hook -------------------------------------------------
-- Gives back a hook this worker claimed but did NOT run (e.g. the sweep ran
-- out of its time budget): clears the lock and undoes the claim's attempt
-- increment, so a hook that keeps getting skipped behind slow ones can
-- never reach the give-up threshold without having run. Fenced on
-- on_dead_locked_by; returns false when fenced out or already handled.
create function public.release_dead_task_hook(
  p_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  update public.background_tasks t
     set on_dead_locked_by = null,
         on_dead_locked_until = null,
         on_dead_attempts = greatest(t.on_dead_attempts - 1, 0)
   where t.id = p_id
     and t.status = 'dead'
     and t.on_dead_handled_at is null
     and t.on_dead_locked_by = p_worker_id;

  return found;
end;
$$;

comment on function public.release_dead_task_hook is
  'Release a claimed-but-unrun onDead hook: clear its lock and refund the attempt (fenced on on_dead_locked_by). Returns false when fenced out or already handled. service_role only.';

-- ---------------------------------------------------------------------
-- Worker read helpers (service_role only)
-- ---------------------------------------------------------------------
-- Not named in §13.3.1, but required to implement §13.9.4 and §13.4.5
-- correctly: PostgREST aggregates are disabled on Supabase by default, and
-- summing/grouping client-side would silently truncate at the API's
-- max_rows (1000) — undercounting spend is a budget bypass. Read-only.

create function public.ai_spend_summary(p_since timestamptz)
returns table (
  provider text,
  operation text,
  cost_usd numeric,
  calls bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select e.provider, e.operation, sum(e.cost_usd) as cost_usd, count(*) as calls
  from public.ai_usage_events e
  where e.created_at >= p_since
  group by e.provider, e.operation
  order by e.provider, e.operation;
$$;

comment on function public.ai_spend_summary is
  'AI spend since p_since grouped by provider and operation (global budget check §13.9.4, GET /api/worker/status). service_role only.';

create function public.background_task_counts()
returns table (
  kind text,
  status text,
  n bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.kind, t.status, count(*) as n
  from public.background_tasks t
  group by t.kind, t.status
  order by t.kind, t.status;
$$;

comment on function public.background_task_counts is
  'Task counts by kind and status for GET /api/worker/status (§13.4.5). service_role only.';

-- ---------------------------------------------------------------------
-- Rate limits
-- ---------------------------------------------------------------------

-- private.consume_rate_limit -----------------------------------------
-- Atomically consume one unit of p_kind for p_user_id today (UTC).
-- Returns false at the limit (callers raise SQLSTATE P0001 with message
-- 'rate_limited:<kind>', mapped to 429 by routes). Called from future
-- security-definer user RPCs (request_resume_report, request_fit_check, ...),
-- which own the auth.uid() check; never exposed to end users.
-- SECURITY DEFINER so it inserts into rate_limit_events regardless of the
-- caller's table privileges (users have none) and can read private.rate_limits.
create function private.consume_rate_limit(
  p_user_id uuid,
  p_kind text,
  p_ref_id uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_used integer;
begin
  if p_user_id is null then
    raise exception 'validation_user_id_required';
  end if;

  select r.daily_limit into v_limit
  from private.rate_limits r
  where r.kind = p_kind;

  if not found then
    -- Config bug, not a user error: maps to 500.
    raise exception 'rate_limit_kind_unknown:%', p_kind;
  end if;

  -- Serializes concurrent consumes for the same user+kind so two requests
  -- at limit-1 cannot both succeed.
  perform pg_advisory_xact_lock(410702, hashtext(p_user_id::text || ':' || p_kind));

  select count(*)::integer into v_used
  from public.rate_limit_events e
  where e.user_id = p_user_id
    and e.kind = p_kind
    and e.refunded_at is null
    and e.created_at >= date_trunc('day', now(), 'UTC');

  if v_used >= v_limit then
    return false;
  end if;

  insert into public.rate_limit_events (user_id, kind, ref_id)
  values (p_user_id, p_kind, p_ref_id);

  return true;
end;
$$;

comment on function private.consume_rate_limit is
  'Atomically consume one daily (UTC) rate-limit unit; returns false at the limit (docs/ARCHITECTURE.md §13.3.1). Internal: called by security-definer user RPCs, never by end users directly.';

-- public.get_my_rate_limits ------------------------------------------
-- User RPC (authenticated): the caller's limits and today's usage, for UI
-- display via lib/rateLimit.ts. Enforcement never depends on this.
create function public.get_my_rate_limits()
returns table (
  kind text,
  daily_limit integer,
  used_today integer,
  resets_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_day_start timestamptz := date_trunc('day', now(), 'UTC');
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  return query
  select
    r.kind,
    r.daily_limit,
    (
      select count(*)::integer
      from public.rate_limit_events e
      where e.user_id = v_uid
        and e.kind = r.kind
        and e.refunded_at is null
        and e.created_at >= v_day_start
    ) as used_today,
    v_day_start + interval '1 day' as resets_at
  from private.rate_limits r
  order by r.kind;
end;
$$;

comment on function public.get_my_rate_limits is
  'The calling user''s daily limits, non-refunded usage today (UTC) and next reset (docs/ARCHITECTURE.md §13.3.1, §13.9.3). Security definer; scoped to auth.uid().';

-- public.consume_account_reauth_attempt ------------------------------
-- User RPC (authenticated), §13.3.1 / §13.13.7: charges one
-- `account_reauth` attempt to the CALLER before DELETE /api/account
-- contacts GoTrue. No arguments, so it can only ever charge auth.uid().
-- Unlike the other rate-limited RPCs it does NOT raise at the limit: it
-- returns false, and the route maps false -> 429 (RPC error -> 500).
create function public.consume_account_reauth_attempt()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  return private.consume_rate_limit(v_uid, 'account_reauth', null);
end;
$$;

comment on function public.consume_account_reauth_attempt is
  'Consume one account_reauth attempt for auth.uid() (docs/ARCHITECTURE.md §13.3.1, §13.13.7). Returns false at the daily limit (does not raise). Security definer; takes no arguments so it can only charge the caller.';

-- ---------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------

revoke execute on function public.enqueue_task(text, text, jsonb, uuid, text, integer, integer, integer, timestamptz, uuid, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_task(text, text, jsonb, uuid, text, integer, integer, integer, timestamptz, uuid, uuid) to service_role;

revoke execute on function public.claim_tasks(text, text, text[], integer, integer) from public, anon, authenticated;
grant execute on function public.claim_tasks(text, text, text[], integer, integer) to service_role;

revoke execute on function public.complete_task(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_task(uuid, text, jsonb) to service_role;

revoke execute on function public.fail_task(uuid, text, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.fail_task(uuid, text, text, text, boolean, integer) to service_role;

revoke execute on function public.snooze_task(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.snooze_task(uuid, text, integer, text) to service_role;

revoke execute on function public.extend_task_lease(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.extend_task_lease(uuid, text, integer) to service_role;

revoke execute on function public.cancel_tasks_for_user(uuid) from public, anon, authenticated;
grant execute on function public.cancel_tasks_for_user(uuid) to service_role;

revoke execute on function public.dead_letter_stale_tasks(interval) from public, anon, authenticated;
grant execute on function public.dead_letter_stale_tasks(interval) to service_role;

revoke execute on function public.claim_dead_task_hooks(text, text[], integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_dead_task_hooks(text, text[], integer, uuid) to service_role;

revoke execute on function public.complete_dead_task_hook(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.complete_dead_task_hook(uuid, text, boolean) to service_role;

revoke execute on function public.release_dead_task_hook(uuid, text) from public, anon, authenticated;
grant execute on function public.release_dead_task_hook(uuid, text) to service_role;

revoke execute on function public.defer_queued_tasks(text, text[], timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.defer_queued_tasks(text, text[], timestamptz, integer, integer) to service_role;

revoke execute on function public.purge_finished_tasks() from public, anon, authenticated;
grant execute on function public.purge_finished_tasks() to service_role;

revoke execute on function public.ai_spend_summary(timestamptz) from public, anon, authenticated;
grant execute on function public.ai_spend_summary(timestamptz) to service_role;

revoke execute on function public.background_task_counts() from public, anon, authenticated;
grant execute on function public.background_task_counts() to service_role;

revoke execute on function private.consume_rate_limit(uuid, text, uuid) from public, anon, authenticated;
grant execute on function private.consume_rate_limit(uuid, text, uuid) to service_role;

-- User RPCs (authenticated only).
revoke execute on function public.get_my_rate_limits() from public, anon;
grant execute on function public.get_my_rate_limits() to authenticated;

revoke execute on function public.consume_account_reauth_attempt() from public, anon;
grant execute on function public.consume_account_reauth_attempt() to authenticated;
