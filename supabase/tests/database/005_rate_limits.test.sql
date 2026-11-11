-- pgTAP: rate limits (migration 0007, §13.3.1, §13.9.3, §13.13.7).
-- private.consume_rate_limit: daily UTC limit, refunds and yesterday's rows
-- don't count, per-user and per-kind isolation, validation.
-- public.consume_account_reauth_attempt (handed off from M1.4c): charges
-- ONLY auth.uid(); 10 allowed per UTC day, the 11th returns false.
-- public.get_my_rate_limits: scoped to auth.uid().
--
-- The concurrency half of "atomic consume" (two consumes at limit-1 can't
-- both succeed) needs two connections: scripts/db-concurrency-check.mjs.
--
-- Auth is simulated the way PostgREST does it: `set local role
-- authenticated` plus the `request.jwt.claims` setting that auth.uid() reads.

begin;

create extension if not exists pgtap with schema extensions;

select plan(27);

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'm13-rl-a@example.test'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'm13-rl-b@example.test');

create function pg_temp.as_user(p_sub text) returns void
language sql
as $$
  select set_config('request.jwt.claims',
    case when p_sub is null then '' else json_build_object('sub', p_sub, 'role', 'authenticated')::text end,
    true);
  select set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
$$;

-- ---------------------------------------------------------------------
-- private.consume_rate_limit (as the owner / service side)
-- ---------------------------------------------------------------------

select throws_ok(
  $$ select private.consume_rate_limit(null, 'resume_report') $$,
  'P0001', 'validation_user_id_required',
  'consume_rate_limit rejects a null user id'
);

select throws_ok(
  $$ select private.consume_rate_limit('aaaaaaaa-0000-4000-8000-00000000000a', 'bogus_kind') $$,
  'P0001', 'rate_limit_kind_unknown:bogus_kind',
  'consume_rate_limit raises on an unconfigured kind (config bug, maps to 500)'
);

select is(
  (select array_agg(private.consume_rate_limit('aaaaaaaa-0000-4000-8000-00000000000a', 'resume_report') order by g)
     from generate_series(1, 6) g),
  array[true, true, true, true, true, false],
  'resume_report (limit 5): five consumes succeed, the sixth returns false'
);

select is(
  (select count(*)::int from public.rate_limit_events
    where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and kind = 'resume_report'),
  5, 'a refused consume inserts no event'
);

update public.rate_limit_events set refunded_at = now()
 where id = (select id from public.rate_limit_events
              where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and kind = 'resume_report' limit 1);

select is(
  (select array_agg(private.consume_rate_limit('aaaaaaaa-0000-4000-8000-00000000000a', 'resume_report') order by g)
     from generate_series(1, 2) g),
  array[true, false],
  'a refunded event frees exactly one unit'
);

select is(private.consume_rate_limit('aaaaaaaa-0000-4000-8000-00000000000a', 'refresh_matches'), true,
  'limits are per kind (refresh_matches unaffected by resume_report)');

select is(private.consume_rate_limit('bbbbbbbb-0000-4000-8000-00000000000b', 'resume_report'), true,
  'limits are per user (B unaffected by A)');

insert into public.rate_limit_events (user_id, kind, created_at)
select 'bbbbbbbb-0000-4000-8000-00000000000b', 'fit_check', date_trunc('day', now(), 'UTC') - interval '1 second'
from generate_series(1, 25);

select is(private.consume_rate_limit('bbbbbbbb-0000-4000-8000-00000000000b', 'fit_check'), true,
  'events before the current UTC day do not count');

do $$
begin
  perform private.consume_rate_limit('bbbbbbbb-0000-4000-8000-00000000000b', 'url_import',
    'cccccccc-0000-4000-8000-00000000000c');
end $$;
select is(
  (select ref_id from public.rate_limit_events
    where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' and kind = 'url_import'),
  'cccccccc-0000-4000-8000-00000000000c'::uuid,
  'p_ref_id is stored for later refunds'
);

-- ---------------------------------------------------------------------
-- consume_account_reauth_attempt
-- ---------------------------------------------------------------------

select is(
  (select pronargs::int from pg_proc where oid = 'public.consume_account_reauth_attempt()'::regprocedure),
  0, 'consume_account_reauth_attempt takes no arguments (it can only charge the caller)'
);

set local role anon;
do $$ begin perform pg_temp.as_user(null); end $$;

select throws_ok(
  $$ select public.consume_account_reauth_attempt() $$,
  '42501', null,
  'anon cannot execute consume_account_reauth_attempt'
);

reset role;
set local role authenticated;
do $$ begin perform pg_temp.as_user(null); end $$;

select throws_ok(
  $$ select public.consume_account_reauth_attempt() $$,
  '42501', 'unauthenticated',
  'authenticated role without a JWT subject is refused (42501 unauthenticated)'
);

do $$ begin perform pg_temp.as_user('aaaaaaaa-0000-4000-8000-00000000000a'); end $$;

select is(
  (select array_agg(public.consume_account_reauth_attempt() order by g) from generate_series(1, 11) g),
  array[true, true, true, true, true, true, true, true, true, true, false],
  'as user A: ten attempts succeed in a UTC day, the 11th returns false (no raise)'
);

select is(public.consume_account_reauth_attempt(), false,
  'further attempts keep returning false');

do $$ begin perform pg_temp.as_user('bbbbbbbb-0000-4000-8000-00000000000b'); end $$;

select is(public.consume_account_reauth_attempt(), true,
  'as user B: A''s exhausted limit does not affect B');

select results_eq(
  $$ select kind, daily_limit, used_today from public.get_my_rate_limits() where kind in ('account_reauth', 'resume_report') order by kind $$,
  $$ values ('account_reauth'::text, 10, 1), ('resume_report'::text, 5, 1) $$,
  'get_my_rate_limits as B shows only B''s usage'
);

select ok(
  (select count(*)::int from public.rate_limit_events where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b') > 0,
  'RLS: B can select its own rate_limit_events rows (the next check is not vacuous)'
);

select is(
  (select count(*)::int from public.rate_limit_events),
  (select count(*)::int from public.rate_limit_events where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b'),
  'RLS: B selects only B''s rate_limit_events rows'
);

select throws_ok(
  $$ select private.consume_rate_limit('aaaaaaaa-0000-4000-8000-00000000000a', 'account_reauth') $$,
  '42501', null,
  'authenticated cannot call private.consume_rate_limit to charge (or probe) another user'
);

select throws_ok(
  $$ insert into public.rate_limit_events (user_id, kind) values ('bbbbbbbb-0000-4000-8000-00000000000b', 'account_reauth') $$,
  '42501', null,
  'authenticated cannot insert rate_limit_events directly'
);

select throws_ok(
  $$ update public.rate_limit_events set refunded_at = now() $$,
  '42501', null,
  'authenticated cannot refund (update) its own events'
);

select throws_ok(
  $$ delete from public.rate_limit_events $$,
  '42501', null,
  'authenticated cannot delete its own events'
);

do $$ begin perform pg_temp.as_user('aaaaaaaa-0000-4000-8000-00000000000a'); end $$;

select is(
  (select used_today from public.get_my_rate_limits() where kind = 'account_reauth'),
  10, 'get_my_rate_limits as A: account_reauth used_today = 10 (refused calls not charged)'
);

select is(
  (select resets_at from public.get_my_rate_limits() where kind = 'account_reauth'),
  date_trunc('day', now(), 'UTC') + interval '1 day',
  'resets_at is the next UTC midnight'
);

do $$ begin perform pg_temp.as_user(null); end $$;
select throws_ok(
  $$ select * from public.get_my_rate_limits() $$,
  '42501', 'unauthenticated',
  'get_my_rate_limits without a JWT subject is refused'
);

reset role;

select is(
  (select count(*)::int from public.rate_limit_events
    where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and kind = 'account_reauth'),
  10, 'as the owner: exactly 10 account_reauth events were charged to A'
);

select is(
  (select count(*)::int from public.rate_limit_events
    where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' and kind = 'account_reauth'),
  1, 'as the owner: exactly 1 account_reauth event was charged to B (only auth.uid() is ever charged)'
);

select * from finish();
rollback;
