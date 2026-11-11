-- pgTAP: dead-task hook outbox (migration 0007, §13.4.5):
-- claim_dead_task_hooks / complete_dead_task_hook / release_dead_task_hook.
-- Claims only dead, unhandled hooks of known kinds whose hook lock is free
-- or expired; completion and release are fenced on on_dead_locked_by.

begin;

create extension if not exists pgtap with schema extensions;

select plan(24);

delete from public.background_tasks;

create function pg_temp.task(p_label text) returns public.background_tasks
language sql
as $$ select t.* from public.background_tasks t where t.dedupe_key = p_label $$;

create function pg_temp.id(p_label text) returns uuid
language sql
as $$ select t.id from public.background_tasks t where t.dedupe_key = p_label $$;

insert into public.background_tasks
  (dedupe_key, kind, task_class, status, max_attempts, lease_seconds, finished_at, last_error_code,
   on_dead_handled_at, on_dead_attempts, on_dead_locked_by, on_dead_locked_until, locked_by, locked_until)
values
  ('h-lock-expired', 'k.a', 'user', 'dead', 3, 60, now() - interval '3 hours', 'ai_refused', null, 4, 'other', clock_timestamp() - interval '1 second', null, null),
  ('h-old', 'k.a', 'user', 'dead', 3, 60, now() - interval '2 hours', 'ai_refused', null, 0, null, null, null, null),
  ('h-new', 'k.a', 'user', 'dead', 3, 60, now() - interval '1 hour', 'lease_expired', null, 0, null, null, null, null),
  ('h-locked', 'k.a', 'user', 'dead', 3, 60, now() - interval '4 hours', 'ai_refused', null, 2, 'other', now() + interval '2 minutes', null, null),
  ('h-unknown', 'gone.kind', 'user', 'dead', 3, 60, now() - interval '5 hours', 'ai_refused', null, 0, null, null, null, null),
  ('h-handled', 'k.a', 'user', 'dead', 3, 60, now() - interval '6 hours', 'ai_refused', now(), 1, null, null, null, null),
  ('h-running', 'k.a', 'user', 'running', 3, 60, null, null, null, 0, null, null, 'w', now() + interval '1 minute');

-- ---------------------------------------------------------------------
-- claim_dead_task_hooks
-- ---------------------------------------------------------------------

select throws_ok(
  $$ select * from public.claim_dead_task_hooks(null, array['k.a'], 5) $$,
  'P0001', 'validation_worker_id_required',
  'claim_dead_task_hooks rejects a null worker id'
);

select is((select count(*)::int from public.claim_dead_task_hooks('w1', '{}'::text[], 5)), 0,
  'empty p_kinds claims nothing');

create temp table first_claim as select * from public.claim_dead_task_hooks('w1', array['k.a'], 1);

select set_eq($$ select dedupe_key from first_claim $$, array['h-lock-expired'],
  'claims in finished_at order, and an expired hook lock is reclaimable');

create temp table second_claim as select * from public.claim_dead_task_hooks('w1', array['k.a'], 10);

select set_eq($$ select dedupe_key from second_claim $$, array['h-old', 'h-new'],
  'claims only dead, unhandled, unlocked hooks of the given kinds');

select ok(
  (select bool_and(on_dead_locked_by = 'w1'
                   and on_dead_locked_until > now() + interval '119 seconds'
                   and on_dead_locked_until < clock_timestamp() + interval '121 seconds')
     from public.background_tasks where dedupe_key in ('h-lock-expired', 'h-old', 'h-new')),
  'claimed hooks are locked to the worker for 120 s'
);

select ok(
  (pg_temp.task('h-old')).on_dead_attempts = 1 and (pg_temp.task('h-lock-expired')).on_dead_attempts = 5,
  'each claim increments on_dead_attempts'
);

select is((select count(*)::int from public.claim_dead_task_hooks('w2', array['k.a'], 10)), 0,
  'a second worker cannot claim hooks whose lock is held');

insert into public.background_tasks (dedupe_key, kind, task_class, status, max_attempts, lease_seconds, finished_at)
values ('h-fast', 'k.a', 'user', 'dead', 3, 60, now()),
       ('h-fast-other', 'k.a', 'user', 'dead', 3, 60, now() - interval '10 hours');

create temp table fast_claim as
  select * from public.claim_dead_task_hooks('w1', array['k.a'], 10, pg_temp.id('h-fast'));

select set_eq($$ select dedupe_key from fast_claim $$, array['h-fast'],
  'with p_task_id only that task is considered (fast path)');

select is((pg_temp.task('h-fast-other')).on_dead_locked_by, null,
  'the fast path leaves other pending hooks alone');

-- ---------------------------------------------------------------------
-- complete_dead_task_hook
-- ---------------------------------------------------------------------

select is(public.complete_dead_task_hook(pg_temp.id('h-old'), 'w2'), false,
  'complete_dead_task_hook by a worker that does not hold the hook lock returns false');

select is(public.complete_dead_task_hook(pg_temp.id('h-old'), 'w1'), true,
  'complete_dead_task_hook by the lock holder returns true');

select ok(
  (select on_dead_handled_at is not null and on_dead_locked_by is null and on_dead_locked_until is null
          and last_error_message is null and last_error_code = 'ai_refused'
     from pg_temp.task('h-old')),
  'completion marks the hook handled and clears its lock (error fields untouched)'
);

select is(public.complete_dead_task_hook(pg_temp.id('h-old'), 'w1'), false,
  'completing an already-handled hook returns false');

select is(public.complete_dead_task_hook(pg_temp.id('h-new'), 'w1', true), true,
  'give-up completion returns true');

select ok(
  (select last_error_message = 'onDead hook gave up after 1 attempts' and last_error_code = 'lease_expired'
          and on_dead_handled_at is not null
     from pg_temp.task('h-new')),
  'give-up records a no-PII note in last_error_message and keeps last_error_code'
);

select is(public.complete_dead_task_hook(pg_temp.id('h-unknown'), null), false,
  'an unclaimed hook cannot be completed (NULL worker id does not match a NULL lock)');

-- ---------------------------------------------------------------------
-- release_dead_task_hook
-- ---------------------------------------------------------------------

select is(public.release_dead_task_hook(pg_temp.id('h-lock-expired'), 'w2'), false,
  'release by a worker that does not hold the hook lock returns false');

select is(public.release_dead_task_hook(pg_temp.id('h-lock-expired'), 'w1'), true,
  'release by the lock holder returns true');

select ok(
  (select on_dead_locked_by is null and on_dead_locked_until is null and on_dead_attempts = 4
          and on_dead_handled_at is null
     from pg_temp.task('h-lock-expired')),
  'release clears the lock and refunds the claim''s attempt; the hook stays pending'
);

select is(public.release_dead_task_hook(pg_temp.id('h-old'), 'w1'), false,
  'releasing a handled hook returns false');

select ok(
  exists (select 1 from public.claim_dead_task_hooks('w3', array['k.a'], 10) where dedupe_key = 'h-lock-expired'),
  'a released hook is immediately claimable again'
);

select ok(
  (select on_dead_locked_by = 'other' and on_dead_attempts = 2 from pg_temp.task('h-locked'))
  and (pg_temp.task('h-unknown')).on_dead_attempts = 0
  and (pg_temp.task('h-handled')).on_dead_attempts = 1
  and (pg_temp.task('h-running')).on_dead_attempts = 0,
  'a live hook lock, an unknown kind, a handled hook and a non-dead task were never claimed'
);

-- ---------------------------------------------------------------------
-- SQL-side deaths enter the outbox
-- ---------------------------------------------------------------------

insert into public.background_tasks (dedupe_key, kind, task_class, status, attempts, max_attempts, lease_seconds, locked_by, locked_until, started_at)
values ('sql-death', 'k.b', 'user', 'running', 3, 3, 60, 'gone-worker', clock_timestamp() - interval '1 second', now());

do $$ begin perform public.claim_tasks('w4', 'user', array['k.b'], 4, 4); end $$;

select is((pg_temp.task('sql-death')).status, 'dead',
  'claim_tasks dead-lettered the final-attempt expired lease');

select ok(
  exists (select 1 from public.claim_dead_task_hooks('w4', array['k.b'], 1, pg_temp.id('sql-death'))),
  'a task killed in SQL (lease_expired) is delivered through the hook outbox'
);

select * from finish();
rollback;
