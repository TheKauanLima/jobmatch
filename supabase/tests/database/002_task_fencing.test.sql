-- pgTAP: fencing and outcomes of complete_task, fail_task, snooze_task and
-- extend_task_lease (migration 0007, §13.3.1, §13.4.4 rule 4).
-- Every mutation is fenced on locked_by = p_worker_id AND status = 'running':
-- a zombie worker whose lease was taken over can't change the outcome.
-- Also: snooze_task never consumes an attempt and keeps a prior error code;
-- fail_task requeues with backoff or dead-letters, and sanitizes its inputs.

begin;

create extension if not exists pgtap with schema extensions;

select plan(34);

delete from public.background_tasks;

create function pg_temp.mk(
  p_label text,
  p_attempts int default 1,
  p_max int default 3,
  p_locked_by text default 'w1',
  p_locked_until timestamptz default null,
  p_last_error_code text default null
) returns uuid
language sql
as $$
  insert into public.background_tasks (
    dedupe_key, kind, task_class, status, attempts, max_attempts, lease_seconds,
    locked_by, locked_until, started_at, last_error_code
  ) values (
    p_label, 't.user', 'user', 'running', p_attempts, p_max, 60,
    p_locked_by, coalesce(p_locked_until, now() + interval '10 minutes'),
    now() - interval '1 minute', p_last_error_code
  )
  returning id;
$$;

create function pg_temp.id(p_label text) returns uuid
language sql
as $$ select t.id from public.background_tasks t where t.dedupe_key = p_label $$;

create function pg_temp.task(p_label text) returns public.background_tasks
language sql
as $$ select t.* from public.background_tasks t where t.dedupe_key = p_label $$;

-- ---------------------------------------------------------------------
-- complete_task
-- ---------------------------------------------------------------------

do $$ begin perform pg_temp.mk('c1'); end $$;

select is(public.complete_task(pg_temp.id('c1'), 'w2', '{"n":1}'::jsonb), false,
  'complete_task with the wrong worker id returns false');

select ok(
  (select status = 'running' and locked_by = 'w1' and result is null from pg_temp.task('c1')),
  'complete_task with the wrong worker id changes nothing'
);

select is(public.complete_task(pg_temp.id('c1'), 'w1', '{"n":1}'::jsonb), true,
  'complete_task by the lease holder returns true');

select ok(
  (select status = 'succeeded' and result = '{"n":1}'::jsonb and finished_at is not null and locked_until is null
     from pg_temp.task('c1')),
  'complete_task marks succeeded, stores result, sets finished_at, clears locked_until'
);

select is(public.complete_task(pg_temp.id('c1'), 'w1', null), false,
  'complete_task on a task that is no longer running returns false');

-- ---------------------------------------------------------------------
-- fail_task
-- ---------------------------------------------------------------------

do $$ begin perform pg_temp.mk('f1'); end $$;

select is(public.fail_task(pg_temp.id('f1'), 'w2', 'ai_unavailable', 'x', true, 30), null,
  'fail_task with the wrong worker id returns NULL');

select ok(
  (select status = 'running' and attempts = 1 and last_error_code is null from pg_temp.task('f1')),
  'fail_task with the wrong worker id changes nothing'
);

select is(public.fail_task(pg_temp.id('f1'), 'w1', 'ai_unavailable', 'Upstream 529', true, 30), 'queued',
  'retryable failure below max_attempts returns queued');

select ok(
  (select status = 'queued' and locked_by is null and locked_until is null and attempts = 1
          and run_after >= now() + interval '29 seconds'
          and last_error_code = 'ai_unavailable' and last_error_message = 'Upstream 529'
     from pg_temp.task('f1')),
  'requeue: lock cleared, attempt kept, run_after = now + delay, error recorded'
);

select is(public.fail_task(pg_temp.id('f1'), 'w1', 'ai_unavailable', 'x', true, 30), null,
  'fail_task on a task that is no longer running returns NULL');

do $$ begin perform pg_temp.mk('f-max', 3, 3); end $$;
select is(public.fail_task(pg_temp.id('f-max'), 'w1', 'ai_unavailable', null, true, 30), 'dead',
  'retryable failure at max_attempts returns dead');

select ok(
  (select status = 'dead' and finished_at is not null and locked_until is null and on_dead_handled_at is null
     from pg_temp.task('f-max')),
  'dead: finished_at set, lock cleared, onDead hook pending'
);

do $$ begin perform pg_temp.mk('f-nonretry'); end $$;
select is(public.fail_task(pg_temp.id('f-nonretry'), 'w1', 'ai_refused', null, false, 30), 'dead',
  'non-retryable failure goes straight to dead');

do $$
begin
  perform pg_temp.mk('f-sanitize');
  perform public.fail_task(
    pg_temp.id('f-sanitize'), 'w1', 'Bad Code!',
    'line1' || chr(10) || chr(7) || 'line2' || repeat('x', 600), true, 30
  );
end $$;

select is((pg_temp.task('f-sanitize')).last_error_code, 'internal_error',
  'fail_task replaces a malformed error code with internal_error');

select ok(
  (select char_length(last_error_message) <= 500 and last_error_message !~ '[[:cntrl:]]'
     from pg_temp.task('f-sanitize')),
  'fail_task strips control characters and truncates the message to 500 chars'
);

do $$
begin
  perform pg_temp.mk('f-negdelay');
  perform public.fail_task(pg_temp.id('f-negdelay'), 'w1', 'internal_error', null, true, -100);
end $$;
-- now() is the transaction start, which is <= the clock fail_task read, so an
-- unclamped -100 s delay would land below it.
select ok((pg_temp.task('f-negdelay')).run_after >= now(),
  'a negative retry delay is clamped to 0 (run_after is never moved into the past)');
select ok((pg_temp.task('f-negdelay')).run_after <= clock_timestamp(),
  'a negative retry delay schedules the retry immediately (run_after <= now)');

-- Zombie worker: its lease expired and another worker reclaimed the task.
do $$
begin
  perform pg_temp.mk('zombie', 1, 3, 'zombie', clock_timestamp() - interval '1 second');
  perform public.claim_tasks('w9', 'user', array['t.user'], 100, 100);
end $$;

select is(public.complete_task(pg_temp.id('zombie'), 'zombie', null), false,
  'a zombie worker cannot complete a task another worker reclaimed');

select is(public.fail_task(pg_temp.id('zombie'), 'zombie', 'internal_error', null, false, 0), null,
  'a zombie worker cannot fail a task another worker reclaimed');

select is(public.complete_task(pg_temp.id('zombie'), 'w9', null), true,
  'the new lease holder can still complete it');

-- ---------------------------------------------------------------------
-- snooze_task
-- ---------------------------------------------------------------------

do $$ begin perform pg_temp.mk('s1', 2, 3); end $$;

select is(public.snooze_task(pg_temp.id('s1'), 'w2', 60, 'batch_not_ready'), false,
  'snooze_task with the wrong worker id returns false');

select ok(
  (select status = 'running' and attempts = 2 from pg_temp.task('s1')),
  'snooze_task with the wrong worker id changes nothing'
);

select is(public.snooze_task(pg_temp.id('s1'), 'w1', 60, 'batch_not_ready'), true,
  'snooze_task by the lease holder returns true');

select ok(
  (select status = 'queued' and attempts = 1 and locked_by is null and locked_until is null
          and run_after >= now() + interval '59 seconds'
          and last_error_code = 'batch_not_ready' and started_at is not null
     from pg_temp.task('s1')),
  'snooze re-queues WITHOUT consuming an attempt (attempts - 1), keeps started_at, records the reason'
);

do $$
begin
  perform pg_temp.mk('s-prior', 2, 3, p_last_error_code => 'ai_invalid_output');
  perform public.snooze_task(pg_temp.id('s-prior'), 'w1', 60, 'budget_exhausted');
end $$;
select is((pg_temp.task('s-prior')).last_error_code, 'ai_invalid_output',
  'snooze keeps a prior attempt''s error code (retry tracking survives)');

do $$
begin
  perform pg_temp.mk('s-badreason');
  perform public.snooze_task(pg_temp.id('s-badreason'), 'w1', 60, 'Bad Reason');
end $$;
select is((pg_temp.task('s-badreason')).last_error_code, 'snoozed',
  'a malformed snooze reason is stored as snoozed');

do $$
begin
  perform pg_temp.mk('s-zero', 0, 3);
  perform public.snooze_task(pg_temp.id('s-zero'), 'w1', 60, 'x');
end $$;
select is((pg_temp.task('s-zero')).attempts, 0, 'snooze never drives attempts below 0');

-- ---------------------------------------------------------------------
-- extend_task_lease
-- ---------------------------------------------------------------------

do $$ begin perform pg_temp.mk('e1'); end $$;

select throws_ok(
  format('select public.extend_task_lease(%L, %L, 0)', pg_temp.id('e1'), 'w1'),
  'P0001', 'validation_seconds_positive',
  'extend_task_lease rejects non-positive seconds'
);

select is(public.extend_task_lease(pg_temp.id('e1'), 'w2', 3600), false,
  'extend_task_lease with the wrong worker id returns false');

create temp table e1_before as select locked_until from pg_temp.task('e1');

-- (Call and check in separate statements: a subquery in the same statement
-- would read the pre-update snapshot.)
select is(public.extend_task_lease(pg_temp.id('e1'), 'w1', 60), true,
  'extend_task_lease by the lease holder returns true');

select is((pg_temp.task('e1')).locked_until, (select locked_until from e1_before),
  'extend_task_lease never shortens an existing lease (10 min left, asked for 60 s)');

select is(public.extend_task_lease(pg_temp.id('e1'), 'w1', 3600), true,
  'extend_task_lease with a longer lease returns true');

select ok((pg_temp.task('e1')).locked_until > now() + interval '59 minutes',
  'extend_task_lease extends to at least now + p_seconds');

select is(public.extend_task_lease(pg_temp.id('c1'), 'w1', 3600), false,
  'extend_task_lease on a finished task returns false');

select * from finish();
rollback;
