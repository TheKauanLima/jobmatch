-- pgTAP: execute privileges on the 0007/0008 functions, the private schema,
-- function hardening (search_path, security definer), and RLS / table
-- privileges on the new tables (§13.3, §13.3.1, §13.3.2, §13.16).

begin;

create extension if not exists pgtap with schema extensions;

select plan(91);

-- Every service-only function from 0007 (regprocedure text).
create temp table service_fns (sig text primary key);
insert into service_fns values
  ('public.enqueue_task(text,text,jsonb,uuid,text,integer,integer,integer,timestamp with time zone,uuid,uuid)'),
  ('public.claim_tasks(text,text,text[],integer,integer)'),
  ('public.complete_task(uuid,text,jsonb)'),
  ('public.fail_task(uuid,text,text,text,boolean,integer)'),
  ('public.snooze_task(uuid,text,integer,text)'),
  ('public.extend_task_lease(uuid,text,integer)'),
  ('public.cancel_tasks_for_user(uuid)'),
  ('public.dead_letter_stale_tasks(interval)'),
  ('public.claim_dead_task_hooks(text,text[],integer,uuid)'),
  ('public.complete_dead_task_hook(uuid,text,boolean)'),
  ('public.release_dead_task_hook(uuid,text)'),
  ('public.defer_queued_tasks(text,text[],timestamp with time zone,integer,integer)'),
  ('public.purge_finished_tasks()'),
  ('public.ai_spend_summary(timestamp with time zone)'),
  ('public.background_task_counts()'),
  ('private.consume_rate_limit(uuid,text,uuid)');

-- ---------------------------------------------------------------------
-- Execute privileges: 16 service functions x 3 roles = 48 tests
-- ---------------------------------------------------------------------

select ok(not has_function_privilege('anon', sig::regprocedure, 'execute'), 'anon cannot execute ' || sig)
  from service_fns order by sig;

select ok(not has_function_privilege('authenticated', sig::regprocedure, 'execute'), 'authenticated cannot execute ' || sig)
  from service_fns order by sig;

select ok(has_function_privilege('service_role', sig::regprocedure, 'execute'), 'service_role can execute ' || sig)
  from service_fns order by sig;

-- Catch-all: anything documented as "service_role only" (so a function
-- added later with that comment but without the revokes is caught).
select is(
  (select count(*)::int from pg_proc p
    where obj_description(p.oid, 'pg_proc') ilike '%service_role only%'
      and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)),
  15, 'the catch-all sweep finds the 15 public functions documented as service_role only'
);

select is(
  (select count(*)::int from pg_proc p
    where obj_description(p.oid, 'pg_proc') ilike '%service_role only%'
      and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
  0, 'no function documented as service_role only is executable by anon or authenticated'
);

-- invoke_worker_tick (0008): only its owner (pg_cron runs as postgres).
select ok(not has_function_privilege('anon', 'private.invoke_worker_tick()', 'execute'),
  'anon cannot execute private.invoke_worker_tick()');
select ok(not has_function_privilege('authenticated', 'private.invoke_worker_tick()', 'execute'),
  'authenticated cannot execute private.invoke_worker_tick()');
select ok(not has_function_privilege('service_role', 'private.invoke_worker_tick()', 'execute'),
  'service_role cannot execute private.invoke_worker_tick() (only pg_cron, as owner)');
select is(
  (select pg_get_userbyid(proowner)::text from pg_proc where oid = 'private.invoke_worker_tick()'::regprocedure),
  'postgres', 'private.invoke_worker_tick() is owned by postgres (the cron job owner)'
);

-- User RPCs: authenticated only.
select ok(has_function_privilege('authenticated', 'public.get_my_rate_limits()', 'execute'),
  'authenticated can execute get_my_rate_limits()');
select ok(not has_function_privilege('anon', 'public.get_my_rate_limits()', 'execute'),
  'anon cannot execute get_my_rate_limits()');
select ok(has_function_privilege('authenticated', 'public.consume_account_reauth_attempt()', 'execute'),
  'authenticated can execute consume_account_reauth_attempt()');
select ok(not has_function_privilege('anon', 'public.consume_account_reauth_attempt()', 'execute'),
  'anon cannot execute consume_account_reauth_attempt()');

-- ---------------------------------------------------------------------
-- private schema and function hardening
-- ---------------------------------------------------------------------

select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon has no USAGE on schema private');
select ok(not has_schema_privilege('authenticated', 'private', 'usage'), 'authenticated has no USAGE on schema private');
select ok(has_schema_privilege('service_role', 'private', 'usage'), 'service_role has USAGE on schema private');

create temp table all_fns (sig text primary key);
insert into all_fns select sig from service_fns;
insert into all_fns values
  ('public.get_my_rate_limits()'),
  ('public.consume_account_reauth_attempt()'),
  ('private.invoke_worker_tick()');

select is(
  (select count(*)::int from all_fns f join pg_proc p on p.oid = f.sig::regprocedure
    where not coalesce('search_path=""' = any(p.proconfig), false)),
  0, 'every 0007/0008 function pins search_path to the empty string'
);

select set_eq(
  $$ select f.sig from all_fns f join pg_proc p on p.oid = f.sig::regprocedure where p.prosecdef $$,
  array['private.consume_rate_limit(uuid,text,uuid)', 'public.get_my_rate_limits()', 'public.consume_account_reauth_attempt()'],
  'only consume_rate_limit and the two no-arg user RPCs are SECURITY DEFINER'
);

-- ---------------------------------------------------------------------
-- RLS flags, policies and table privileges
-- ---------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.background_tasks'::regclass), 'RLS enabled on background_tasks');
select ok((select relrowsecurity from pg_class where oid = 'public.ai_usage_events'::regclass), 'RLS enabled on ai_usage_events');
select ok((select relrowsecurity from pg_class where oid = 'public.rate_limit_events'::regclass), 'RLS enabled on rate_limit_events');
select ok((select relrowsecurity from pg_class where oid = 'private.rate_limits'::regclass), 'RLS enabled on private.rate_limits');

select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'background_tasks'), 0,
  'background_tasks has no policies (server-only)');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'ai_usage_events'), 0,
  'ai_usage_events has no policies (server-only)');
select results_eq(
  $$ select policyname::text, cmd::text, roles::text[] from pg_policies where schemaname = 'public' and tablename = 'rate_limit_events' $$,
  $$ values ('rate_limit_events_select_own'::text, 'SELECT'::text, array['authenticated']::text[]) $$,
  'rate_limit_events has exactly one policy: SELECT to authenticated'
);

select ok(not has_table_privilege('anon', 'public.background_tasks', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'anon has no privileges on background_tasks');
select ok(not has_table_privilege('authenticated', 'public.background_tasks', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'authenticated has no privileges on background_tasks');
select ok(not has_table_privilege('anon', 'public.ai_usage_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'anon has no privileges on ai_usage_events');
select ok(not has_table_privilege('authenticated', 'public.ai_usage_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'authenticated has no privileges on ai_usage_events');
select ok(not has_table_privilege('anon', 'public.rate_limit_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'anon has no privileges on rate_limit_events');
select ok(has_table_privilege('authenticated', 'public.rate_limit_events', 'SELECT'),
  'authenticated has SELECT on rate_limit_events');
select ok(not has_table_privilege('authenticated', 'public.rate_limit_events', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'authenticated has no write privileges on rate_limit_events');
select ok(not has_table_privilege('anon', 'private.rate_limits', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'anon has no privileges on private.rate_limits');
select ok(not has_table_privilege('authenticated', 'private.rate_limits', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'authenticated has no privileges on private.rate_limits');
select ok(not has_table_privilege('service_role', 'private.rate_limits', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'service_role has no privileges on private.rate_limits (read only via security-definer functions)');

-- ---------------------------------------------------------------------
-- Behaviour as real API roles, with rows for two users
-- ---------------------------------------------------------------------

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000a6', 'm13-priv-a@example.test'),
  ('bbbbbbbb-0000-4000-8000-0000000000b6', 'm13-priv-b@example.test');

insert into public.background_tasks (kind, task_class, user_id, max_attempts, lease_seconds)
values ('x.user', 'user', 'aaaaaaaa-0000-4000-8000-0000000000a6', 3, 60);

insert into public.ai_usage_events (user_id, provider, operation, model, cost_usd)
values ('aaaaaaaa-0000-4000-8000-0000000000a6', 'anthropic', 'critique', 'claude-opus-5-5', 0.1);

insert into public.rate_limit_events (id, user_id, kind) values
  ('a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000a6', 'resume_report'),
  ('a0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-0000000000a6', 'fit_check'),
  ('b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-0000000000b6', 'resume_report');

set local role authenticated;
do $$
begin
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a6","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-0000000000a6', true);
end $$;

select throws_ok($$ select * from public.background_tasks $$, '42501', null,
  'authenticated (even the task''s own user) cannot read background_tasks');
select throws_ok($$ select * from public.ai_usage_events $$, '42501', null,
  'authenticated (even the event''s own user) cannot read ai_usage_events');
select throws_ok(
  $$ insert into public.background_tasks (kind, task_class, max_attempts, lease_seconds) values ('x.user', 'user', 3, 60) $$,
  '42501', null, 'authenticated cannot insert into background_tasks');
select throws_ok($$ select * from private.rate_limits $$, '42501', null,
  'authenticated cannot read private.rate_limits');
select throws_ok(
  $$ select * from public.claim_tasks('evil', 'user', array['x.user'], 100, 100) $$,
  '42501', null, 'authenticated cannot call claim_tasks through a crafted RPC');
select throws_ok(
  $$ select public.enqueue_task(p_kind => 'x.user', p_task_class => 'user') $$,
  '42501', null, 'authenticated cannot call enqueue_task through a crafted RPC');
select throws_ok(
  $$ select public.cancel_tasks_for_user('bbbbbbbb-0000-4000-8000-0000000000b6') $$,
  '42501', null, 'authenticated cannot cancel another user''s tasks');

select set_eq(
  $$ select id from public.rate_limit_events $$,
  array['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002']::uuid[],
  'authenticated A sees exactly A''s own rate_limit_events'
);

select is(
  (select count(*)::int from public.rate_limit_events where user_id = 'bbbbbbbb-0000-4000-8000-0000000000b6'),
  0, 'a crafted filter on B''s user_id returns nothing for A'
);

reset role;
set local role anon;
do $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

select throws_ok($$ select * from public.rate_limit_events $$, '42501', null,
  'anon cannot read rate_limit_events');
select throws_ok($$ select * from public.background_tasks $$, '42501', null,
  'anon cannot read background_tasks');

reset role;

select * from finish();
rollback;
