-- pgTAP: public.claim_tasks (migration 0007, docs/ARCHITECTURE.md §13.3.1).
-- Covers: argument validation, class caps (live leases of ALL kinds count),
-- ordering, run_after, unknown kinds left alone, lease-expiry reclaim
-- (expired leases don't count toward the cap), dead-lettering at
-- max_attempts (lease_expired), class/kind scoping of the dead-letter step.
--
-- `for update skip locked` and the advisory-lock cap across CONCURRENT
-- claimers need two connections and are covered by
-- scripts/db-concurrency-check.mjs, not here (pgTAP runs in one session).
--
-- Runs as `postgres` (owner of the functions) inside one rolled-back
-- transaction. Uses clock_timestamp()-relative fixtures because claim_tasks
-- reads the clock itself.

begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

-- Isolate from anything already in the local queue (rolled back at the end).
delete from public.background_tasks;

-- Fixture helper. dedupe_key doubles as a human-readable label (unique per
-- test, so the live-key index never interferes).
create function pg_temp.mk(
  p_label text,
  p_kind text,
  p_class text,
  p_status text default 'queued',
  p_attempts int default 0,
  p_max int default 3,
  p_locked_by text default null,
  p_locked_until timestamptz default null,
  p_run_after timestamptz default null,
  p_priority int default 0
) returns uuid
language sql
as $$
  insert into public.background_tasks (
    dedupe_key, kind, task_class, status, attempts, max_attempts, lease_seconds,
    locked_by, locked_until, run_after, priority, started_at
  ) values (
    p_label, p_kind, p_class, p_status, p_attempts, p_max, 60,
    p_locked_by, p_locked_until, coalesce(p_run_after, now() - interval '1 minute'), p_priority,
    case when p_status = 'running' then now() - interval '1 hour' end
  )
  returning id;
$$;

create function pg_temp.task(p_label text) returns public.background_tasks
language sql
as $$ select t.* from public.background_tasks t where t.dedupe_key = p_label $$;

-- ---------------------------------------------------------------------
-- Validation and no-op arguments
-- ---------------------------------------------------------------------

select throws_ok(
  $$ select * from public.claim_tasks(null, 'user', array['t.user'], 4, 4) $$,
  'P0001', 'validation_worker_id_required',
  'claim_tasks rejects a null worker id'
);

select throws_ok(
  $$ select * from public.claim_tasks('', 'user', array['t.user'], 4, 4) $$,
  'P0001', 'validation_worker_id_required',
  'claim_tasks rejects an empty worker id'
);

select throws_ok(
  $$ select * from public.claim_tasks('w', 'nope', array['t.user'], 4, 4) $$,
  'P0001', 'validation_task_class_invalid',
  'claim_tasks rejects an unknown task class'
);

do $$ begin perform pg_temp.mk('q-any', 't.user', 'user'); end $$;

select is(
  (select count(*)::int from public.claim_tasks('w0', 'user', '{}'::text[], 4, 4)),
  0, 'empty p_kinds claims nothing'
);

select is(
  (select count(*)::int from public.claim_tasks('w0', 'user', array['t.user'], 4, 0)),
  0, 'p_limit = 0 claims nothing'
);

select is(
  (select count(*)::int from public.claim_tasks('w0', 'user', array['t.user'], 0, 4)),
  0, 'p_max_running = 0 claims nothing'
);

select is((pg_temp.task('q-any')).status, 'queued', 'no-op calls leave the task queued');

delete from public.background_tasks;

-- ---------------------------------------------------------------------
-- Class cap: live leases of every kind in the class count
-- ---------------------------------------------------------------------

do $$
begin
  perform pg_temp.mk('q' || g, 't.user', 'user') from generate_series(1, 6) g;
  -- A live lease of a DIFFERENT kind in the same class (another deployment's work).
  perform pg_temp.mk('live-other', 'other.user', 'user', 'running', 1, 3, 'other-worker', now() + interval '1 hour');
end $$;

create temp table c1 as
  select * from public.claim_tasks('w1', 'user', array['t.user'], 4, 10);

select is((select count(*)::int from c1), 3,
  'claims only max_running - live leases (4 - 1 other-kind live lease = 3)');

select ok(
  (select bool_and(status = 'running' and attempts = 1 and locked_by = 'w1' and started_at is not null) from c1),
  'claimed rows are running, attempts = 1, locked_by = worker, started_at set'
);

select ok(
  (select bool_and(locked_until > now() + interval '59 seconds' and locked_until < clock_timestamp() + interval '61 seconds') from c1),
  'claimed rows get locked_until = now + lease_seconds'
);

select is(
  (select count(*)::int from public.claim_tasks('w2', 'user', array['t.user'], 4, 10)),
  0, 'a second claimer gets nothing while the class cap is full'
);

select is(
  (select count(*)::int from public.background_tasks where status = 'queued' and kind = 't.user'),
  3, 'the remaining tasks stay queued'
);

do $$ begin perform pg_temp.mk('bg1', 'b.bg', 'background'); end $$;
select is(
  (select count(*)::int from public.claim_tasks('w2', 'background', array['b.bg'], 2, 10)),
  1, 'the background class cap is independent of the user class'
);

delete from public.background_tasks;

-- ---------------------------------------------------------------------
-- Ordering, run_after, unknown kinds
-- ---------------------------------------------------------------------

do $$
begin
  perform pg_temp.mk('old-p0', 't.user', 'user', p_run_after => now() - interval '20 minutes', p_priority => 0);
  perform pg_temp.mk('new-p0', 't.user', 'user', p_run_after => now() - interval '10 minutes', p_priority => 0);
  perform pg_temp.mk('new-p5', 't.user', 'user', p_run_after => now() - interval '1 minute', p_priority => 5);
  perform pg_temp.mk('future', 't.user', 'user', p_run_after => now() + interval '1 hour', p_priority => 100);
  perform pg_temp.mk('unknown', 'unknown.kind', 'user', p_priority => 100);
end $$;

create temp table c2 as
  select * from public.claim_tasks('w3', 'user', array['t.user'], 4, 2);

select set_eq(
  $$ select dedupe_key from c2 $$,
  array['new-p5', 'old-p0'],
  'claims by priority desc, then run_after asc'
);

select is((pg_temp.task('future')).status, 'queued', 'a task with run_after in the future is not claimed');
select is((pg_temp.task('unknown')).status, 'queued', 'a kind outside p_kinds is never claimed');

delete from public.background_tasks;

-- ---------------------------------------------------------------------
-- Lease expiry: reclaim, and expired leases don't count toward the cap
-- ---------------------------------------------------------------------

do $$
begin
  perform pg_temp.mk('exp' || g, 't.user', 'user', 'running', 1, 3, 'dead-worker', clock_timestamp() - interval '1 second')
  from generate_series(1, 4) g;
end $$;

create temp table started_before as
  select dedupe_key, started_at from public.background_tasks;

create temp table c3 as
  select * from public.claim_tasks('w4', 'user', array['t.user'], 4, 4);

select is((select count(*)::int from c3), 4,
  'expired leases do not count toward the cap; all four are reclaimable');

select ok(
  (select bool_and(locked_by = 'w4' and attempts = 2 and status = 'running') from c3),
  'a reclaimed task gets the new worker id and consumes an attempt'
);

select ok(
  (select bool_and(c.started_at = s.started_at) from c3 c join started_before s using (dedupe_key)),
  'reclaim keeps the original started_at'
);

delete from public.background_tasks;

-- ---------------------------------------------------------------------
-- Dead-lettering at max_attempts
-- ---------------------------------------------------------------------

do $$
begin
  perform pg_temp.mk('at-max', 't.user', 'user', 'running', 3, 3, 'dead-worker', clock_timestamp() - interval '1 second');
  perform pg_temp.mk('below-max', 't.user', 'user', 'running', 2, 3, 'dead-worker', clock_timestamp() - interval '1 second');
  perform pg_temp.mk('at-max-live', 't.user', 'user', 'running', 3, 3, 'live-worker', now() + interval '1 hour');
  perform pg_temp.mk('at-max-unknown', 'unknown.kind', 'user', 'running', 3, 3, 'dead-worker', clock_timestamp() - interval '1 second');
  perform pg_temp.mk('at-max-bg', 't.user', 'background', 'running', 3, 3, 'dead-worker', clock_timestamp() - interval '1 second');
end $$;

create temp table c4 as
  select * from public.claim_tasks('w5', 'user', array['t.user'], 4, 4);

select ok(
  (select t.status = 'dead' and t.last_error_code = 'lease_expired'
          and t.finished_at is not null and t.locked_until is null
     from pg_temp.task('at-max') t),
  'an expired lease at max_attempts is dead-lettered with lease_expired'
);

select ok(
  not exists (select 1 from c4 where dedupe_key = 'at-max'),
  'the dead-lettered task is not returned as claimed'
);

select set_eq(
  $$ select dedupe_key from c4 $$,
  array['below-max'],
  'only the expired lease below max_attempts is reclaimed'
);

select is((pg_temp.task('at-max-live')).status, 'running',
  'a live lease at max_attempts is not touched');

select is((pg_temp.task('at-max-unknown')).status, 'running',
  'dead-lettering only applies to p_kinds (unknown kinds wait for the stale-lease sweep)');

select is((pg_temp.task('at-max-bg')).status, 'running',
  'dead-lettering only applies to the claimed class');

select * from finish();
rollback;
