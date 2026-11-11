-- pgTAP: enqueue_task idempotency and the live dedupe_key partial unique
-- index; defer_queued_tasks; cancel_tasks_for_user; dead_letter_stale_tasks
-- (threshold guard); purge_finished_tasks retention (migration 0007).

begin;

create extension if not exists pgtap with schema extensions;

select plan(34);

delete from public.background_tasks;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'm13-a@example.test'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'm13-b@example.test');

create function pg_temp.task(p_label text) returns public.background_tasks
language sql
as $$ select t.* from public.background_tasks t where t.dedupe_key = p_label $$;

-- ---------------------------------------------------------------------
-- enqueue_task + dedupe index
-- ---------------------------------------------------------------------

select throws_ok(
  $$ select public.enqueue_task(p_kind => null, p_task_class => 'user') $$,
  'P0001', 'validation_kind_required',
  'enqueue_task rejects a null kind'
);

create temp table ids (label text primary key, id uuid);

insert into ids values ('first', public.enqueue_task(p_kind => 'x.user', p_task_class => 'user', p_dedupe_key => 'k1'));
insert into ids values ('second', public.enqueue_task(p_kind => 'x.user', p_task_class => 'user', p_dedupe_key => 'k1'));

select is((select id from ids where label = 'second'), (select id from ids where label = 'first'),
  'enqueue_task with a live dedupe_key returns the existing task id');

select is((select count(*)::int from public.background_tasks where dedupe_key = 'k1'), 1,
  'only one row exists for the live key');

update public.background_tasks set status = 'running', attempts = 1, locked_by = 'w', locked_until = now() + interval '1 minute'
 where dedupe_key = 'k1';
insert into ids values ('while-running', public.enqueue_task(p_kind => 'x.user', p_task_class => 'user', p_dedupe_key => 'k1'));

select is((select id from ids where label = 'while-running'), (select id from ids where label = 'first'),
  'a running task also holds its dedupe_key (same id returned)');

update public.background_tasks set status = 'succeeded', locked_until = null, finished_at = now()
 where dedupe_key = 'k1';
insert into ids values ('after-finish', public.enqueue_task(p_kind => 'x.user', p_task_class => 'user', p_dedupe_key => 'k1'));

select isnt((select id from ids where label = 'after-finish'), (select id from ids where label = 'first'),
  'once the task finished, the key is free and a new task is created');

select is((select count(*)::int from public.background_tasks where dedupe_key = 'k1'), 2,
  'finished + new live row coexist for the same key');

select throws_ok(
  $$ insert into public.background_tasks (kind, task_class, max_attempts, lease_seconds, dedupe_key)
     values ('x.user', 'user', 3, 60, 'k1') $$,
  '23505', null,
  'the partial unique index rejects a second LIVE row with the same key on direct insert'
);

select lives_ok(
  $$ insert into public.background_tasks (kind, task_class, status, max_attempts, lease_seconds, dedupe_key) values
       ('x.user', 'user', 'dead', 3, 60, 'k2'),
       ('x.user', 'user', 'dead', 3, 60, 'k2'),
       ('x.user', 'user', 'cancelled', 3, 60, 'k2'),
       ('x.user', 'user', 'succeeded', 3, 60, 'k2'),
       ('x.user', 'user', 'queued', 3, 60, 'k2') $$,
  'any number of finished rows plus one live row may share a key'
);

insert into ids values ('null-1', public.enqueue_task(p_kind => 'x.user', p_task_class => 'user'));
insert into ids values ('null-2', public.enqueue_task(p_kind => 'x.user', p_task_class => 'user'));

select isnt((select id from ids where label = 'null-1'), (select id from ids where label = 'null-2'),
  'tasks without a dedupe_key are never deduplicated');

select ok(
  (select status = 'queued' and attempts = 0 and max_attempts = 3 and lease_seconds = 300
          and priority = 0 and payload = '{}'::jsonb and run_after <= clock_timestamp()
     from public.background_tasks where id = (select id from ids where label = 'null-1')),
  'enqueue_task defaults: queued, 0 attempts, max 3, lease 300 s, priority 0, empty payload, due now'
);

select throws_ok(
  $$ select public.enqueue_task(p_kind => 'x.user', p_task_class => 'user', p_payload => '[]'::jsonb) $$,
  '23514', null,
  'a non-object payload violates the check constraint'
);

select throws_ok(
  format($$ select public.enqueue_task(p_kind => 'x.user', p_task_class => 'user', p_payload => %L::jsonb) $$,
         jsonb_build_object('blob', repeat('x', 5000))::text),
  '23514', null,
  'a payload over 4096 bytes violates the check constraint'
);

select throws_ok(
  $$ select public.enqueue_task(p_kind => 'x.user', p_task_class => 'vip') $$,
  '23514', null,
  'an unknown task class violates the check constraint'
);

-- ---------------------------------------------------------------------
-- defer_queued_tasks
-- ---------------------------------------------------------------------

delete from public.background_tasks;

insert into public.background_tasks
  (dedupe_key, kind, task_class, status, attempts, max_attempts, lease_seconds, run_after, last_error_code, locked_by, locked_until, started_at)
values
  ('d-ai', 'ai.user', 'user', 'queued', 1, 3, 60, now() - interval '1 minute', 'ai_invalid_output', null, null, null),
  ('d-future', 'ai.user', 'user', 'queued', 0, 3, 60, now() + interval '2 days', null, null, null, null),
  ('d-other', 'plain.user', 'user', 'queued', 0, 3, 60, now() - interval '1 minute', null, null, null, null),
  ('d-running', 'ai.user', 'user', 'running', 1, 3, 60, now() - interval '1 minute', null, 'w', now() + interval '1 minute', now()),
  ('d-bg', 'ai.user', 'background', 'queued', 0, 3, 60, now() - interval '1 minute', null, null, null, null);

create temp table before_defer as
  select dedupe_key, status, run_after, attempts from public.background_tasks;

select throws_ok(
  $$ select * from public.defer_queued_tasks('vip', array['ai.user'], now()) $$,
  'P0001', 'validation_task_class_invalid',
  'defer_queued_tasks rejects an unknown class'
);

select throws_ok(
  $$ select * from public.defer_queued_tasks('user', array['ai.user'], null) $$,
  'P0001', 'validation_until_required',
  'defer_queued_tasks rejects a null p_until'
);

select is(
  (select count(*)::int from public.defer_queued_tasks('user', '{}'::text[], now() + interval '1 day')),
  0, 'empty p_kinds defers nothing'
);

create temp table deferred1 as
  select * from public.defer_queued_tasks('user', array['ai.user'], date_trunc('day', now()) + interval '1 day', 0, 200);

select set_eq($$ select dedupe_key from deferred1 $$, array['d-ai'],
  'defers only claimable (queued, due) tasks of p_kinds in p_task_class');

select is((pg_temp.task('d-ai')).run_after, date_trunc('day', now()) + interval '1 day',
  'run_after moved to p_until (jitter 0)');

select ok(
  (select status = 'queued' and attempts = 1 and started_at is null and locked_by is null
          and last_error_code = 'ai_invalid_output'
     from pg_temp.task('d-ai')),
  'deferral never claims: attempts, started_at, lock and last_error_code untouched'
);

select set_eq(
  $$ select dedupe_key, status, run_after, attempts from public.background_tasks where dedupe_key <> 'd-ai' $$,
  $$ select dedupe_key, status, run_after, attempts from before_defer where dedupe_key <> 'd-ai' $$,
  'future, other-kind, running and other-class tasks are untouched'
);

insert into public.background_tasks (dedupe_key, kind, task_class, max_attempts, lease_seconds, run_after)
select 'j' || g, 'ai.user', 'user', 3, 60, now() - interval '1 minute' from generate_series(1, 3) g;

create temp table deferred2 as
  select * from public.defer_queued_tasks('user', array['ai.user'], date_trunc('day', now()) + interval '1 day', 900, 2);

select is((select count(*)::int from deferred2), 2, 'p_limit bounds the number deferred per call');

select ok(
  (select bool_and(run_after >= date_trunc('day', now()) + interval '1 day'
               and run_after <= date_trunc('day', now()) + interval '1 day' + interval '900 seconds')
     from deferred2),
  'jitter stays within [p_until, p_until + p_max_jitter_seconds]'
);

delete from public.background_tasks where dedupe_key like 'j%';
insert into public.background_tasks (dedupe_key, kind, task_class, max_attempts, lease_seconds, run_after)
values ('past-until', 'ai.user', 'user', 3, 60, now() - interval '1 minute');
do $$ begin perform public.defer_queued_tasks('user', array['ai.user'], now() - interval '1 day', 0, 200); end $$;

select ok((pg_temp.task('past-until')).run_after >= now(),
  'a p_until in the past never moves run_after backwards (greatest(p_until, now))');

-- ---------------------------------------------------------------------
-- cancel_tasks_for_user
-- ---------------------------------------------------------------------

delete from public.background_tasks;

insert into public.background_tasks (dedupe_key, kind, task_class, status, user_id, max_attempts, lease_seconds, locked_by, locked_until) values
  ('a-q1', 'x.user', 'user', 'queued', 'aaaaaaaa-0000-4000-8000-000000000001', 3, 60, null, null),
  ('a-q2', 'x.user', 'user', 'queued', 'aaaaaaaa-0000-4000-8000-000000000001', 3, 60, null, null),
  ('a-run', 'x.user', 'user', 'running', 'aaaaaaaa-0000-4000-8000-000000000001', 3, 60, 'w', now() + interval '1 minute'),
  ('b-q', 'x.user', 'user', 'queued', 'bbbbbbbb-0000-4000-8000-000000000002', 3, 60, null, null);

select throws_ok(
  $$ select public.cancel_tasks_for_user(null) $$,
  'P0001', 'validation_user_id_required',
  'cancel_tasks_for_user rejects a null user id'
);

select is(public.cancel_tasks_for_user('aaaaaaaa-0000-4000-8000-000000000001'), 2,
  'cancel_tasks_for_user returns the number of queued tasks cancelled');

select ok(
  (select bool_and(status = 'cancelled' and finished_at is not null) from public.background_tasks where dedupe_key in ('a-q1', 'a-q2'))
  and (pg_temp.task('a-run')).status = 'running'
  and (pg_temp.task('b-q')).status = 'queued',
  'only the user''s QUEUED tasks are cancelled; running tasks and other users are untouched'
);

-- ---------------------------------------------------------------------
-- dead_letter_stale_tasks
-- ---------------------------------------------------------------------

delete from public.background_tasks;

insert into public.background_tasks (dedupe_key, kind, task_class, status, attempts, max_attempts, lease_seconds, locked_by, locked_until, run_after) values
  ('stale-11m', 'gone.kind', 'user', 'running', 1, 3, 60, 'w', clock_timestamp() - interval '11 minutes', now()),
  ('fresh-5m', 'gone.kind', 'user', 'running', 1, 3, 60, 'w', clock_timestamp() - interval '5 minutes', now()),
  ('stale-7h', 'gone.kind', 'background', 'running', 1, 3, 60, 'w', clock_timestamp() - interval '7 hours', now()),
  ('queued-old', 'gone.kind', 'user', 'queued', 0, 3, 60, null, null, now() - interval '30 days');

select throws_ok(
  $$ select public.dead_letter_stale_tasks(interval '9 minutes 59 seconds') $$,
  'P0001', 'validation_older_than_too_small',
  'dead_letter_stale_tasks refuses a threshold under 10 minutes'
);

select throws_ok(
  $$ select public.dead_letter_stale_tasks(null) $$,
  'P0001', 'validation_older_than_too_small',
  'dead_letter_stale_tasks refuses a null threshold'
);

select is(public.dead_letter_stale_tasks(), 1,
  'the default 6 h threshold only dead-letters the 7 h stale lease');

select is(public.dead_letter_stale_tasks(interval '10 minutes'), 1,
  'a 10-minute threshold (the minimum) is accepted and dead-letters the 11-minute stale lease');

select ok(
  (select bool_and(status = 'dead' and last_error_code = 'lease_expired' and finished_at is not null
                   and locked_until is null and on_dead_handled_at is null)
     from public.background_tasks where dedupe_key in ('stale-11m', 'stale-7h')),
  'stale leases (any kind, any class) are dead with lease_expired and enter the hook outbox'
);

select ok(
  (pg_temp.task('fresh-5m')).status = 'running' and (pg_temp.task('queued-old')).status = 'queued',
  'leases younger than the threshold and queued tasks are untouched'
);

-- ---------------------------------------------------------------------
-- purge_finished_tasks
-- ---------------------------------------------------------------------

delete from public.background_tasks;

insert into public.background_tasks (dedupe_key, kind, task_class, status, max_attempts, lease_seconds, finished_at, on_dead_handled_at) values
  ('succ-15d', 'x.user', 'user', 'succeeded', 3, 60, now() - interval '15 days', null),
  ('succ-13d', 'x.user', 'user', 'succeeded', 3, 60, now() - interval '13 days', null),
  ('canc-15d', 'x.user', 'user', 'cancelled', 3, 60, now() - interval '15 days', null),
  ('dead-31d-handled', 'x.user', 'user', 'dead', 3, 60, now() - interval '31 days', now()),
  ('dead-31d-pending', 'x.user', 'user', 'dead', 3, 60, now() - interval '31 days', null),
  ('dead-29d-handled', 'x.user', 'user', 'dead', 3, 60, now() - interval '29 days', now()),
  ('queued', 'x.user', 'user', 'queued', 3, 60, null, null);

select is(public.purge_finished_tasks(), 3, 'purge_finished_tasks returns the number of rows deleted');

select set_eq(
  $$ select dedupe_key from public.background_tasks $$,
  array['succ-13d', 'dead-31d-pending', 'dead-29d-handled', 'queued'],
  'keeps recent rows, live rows, and dead rows whose onDead hook is still pending'
);

select * from finish();
rollback;
