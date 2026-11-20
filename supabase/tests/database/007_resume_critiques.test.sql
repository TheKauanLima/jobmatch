-- pgTAP: resume critiques (migration 0010, docs/ARCHITECTURE.md §13.20.2,
-- §13.3.8; ROADMAP V1.1).
--   * table shape guards: RLS on, exactly one owner-select policy, table
--     privileges (authenticated SELECT only, anon nothing), check
--     constraints, the standalone cache key;
--   * the same-owner trigger (validation_owner_mismatch on insert and on
--     UPDATE OF resume_id/user_id, including a missing resume; updates of
--     other columns don't fire it);
--   * anon has no access; service_role can insert, still trigger-guarded;
--   * owner-only RLS: B cannot see A's critiques; A cannot write any;
--   * cascade: deleting a resume or a user removes its critiques;
--   * request_resume_critique: privileges and hardening, unauthenticated,
--     not_found for another user's (or a missing) resume, 5 charges then
--     rate_limited:resume_report, charges ONLY auth.uid(), ref_id = the
--     returned id, inserts no critique row.
--
-- UNRUN against a local Supabase stack (it couldn't start in the V1.1
-- environment). Validated instead on PGlite (Postgres 17 in WASM, with
-- pgTAP) against a minimal Supabase shim; see the V1.1 PR notes.
--
-- Auth is simulated the way PostgREST does it: `set local role
-- authenticated` plus the `request.jwt.claims` setting that auth.uid() reads.

begin;

create extension if not exists pgtap with schema extensions;

select plan(59);

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'v1-crit-a@example.test'),
  ('bbbbbbbb-0000-4000-8000-0000000000c2', 'v1-crit-b@example.test');

insert into public.resumes (id, user_id, storage_path, file_name, file_type, file_size_bytes, extracted_text) values
  ('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'a/r1.pdf', 'r1.pdf', 'application/pdf', 10, 'synthetic resume A1'),
  ('a0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'a/r2.pdf', 'r2.pdf', 'application/pdf', 10, 'synthetic resume A2'),
  ('b0000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-0000000000c2', 'b/r1.pdf', 'r1.pdf', 'application/pdf', 10, 'synthetic resume B1');

create function pg_temp.as_user(p_sub text) returns void
language sql
as $$
  select set_config('request.jwt.claims',
    case when p_sub is null then '' else json_build_object('sub', p_sub, 'role', 'authenticated')::text end,
    true);
  select set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
$$;

-- A minimal valid critique row for (resume, user, prompt version, report id).
create function pg_temp.insert_critique(p_resume uuid, p_user uuid, p_version text default 'critique-v1', p_report uuid default null)
returns uuid
language sql
as $$
  insert into public.resume_critiques
    (resume_id, user_id, report_id, prompt_version, model, overall_score, summary, student_context, dimension_scores)
  values
    (p_resume, p_user, p_report, p_version, 'claude-opus-5-5', 71, 'synthetic summary',
     '{"stage":"late_student","note":"n"}', '[]')
  returning id;
$$;

-- ---------------------------------------------------------------------
-- Table guards (as the owner)
-- ---------------------------------------------------------------------

select has_table('public', 'resume_critiques', 'resume_critiques exists');

select ok((select relrowsecurity from pg_class where oid = 'public.resume_critiques'::regclass),
  'RLS enabled on resume_critiques');

select is(
  (select count(*)::int from pg_policy where polrelid = 'public.resume_critiques'::regclass),
  1, 'resume_critiques has exactly one policy'
);

select ok(
  exists (
    select 1 from pg_policy
     where polrelid = 'public.resume_critiques'::regclass
       and polname = 'resume_critiques_select_own'
       and polcmd = 'r'
       and polroles = array['authenticated'::regrole::oid]
       and pg_get_expr(polqual, polrelid) ilike '%user_id = ( SELECT auth.uid()%'
  ),
  'that policy is resume_critiques_select_own: FOR SELECT TO authenticated USING (user_id = (select auth.uid()))'
);

select ok(has_table_privilege('authenticated', 'public.resume_critiques', 'SELECT'),
  'authenticated has SELECT on resume_critiques');
select ok(not has_table_privilege('authenticated', 'public.resume_critiques', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'authenticated has no write privileges on resume_critiques');
select ok(not has_table_privilege('anon', 'public.resume_critiques', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'anon has no privileges on resume_critiques');
select ok(has_table_privilege('service_role', 'public.resume_critiques', 'SELECT,INSERT'),
  'service_role can select and insert (the V1 route writes through it)');

select lives_ok(
  $$ select pg_temp.insert_critique('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000c1') $$,
  'a critique whose user_id owns the resume inserts'
);

select throws_ok(
  $$ select pg_temp.insert_critique('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000c1') $$,
  '23505', null,
  'a second standalone critique for the same (resume, prompt_version) violates resume_critiques_standalone_key'
);

select lives_ok(
  $$ select pg_temp.insert_critique('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'critique-v2') $$,
  'a new prompt_version gets its own standalone critique'
);

select lives_ok(
  $$ select pg_temp.insert_critique('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'critique-v1', 'cccccccc-0000-4000-8000-000000000001');
     select pg_temp.insert_critique('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'critique-v1', 'cccccccc-0000-4000-8000-000000000002') $$,
  'report critiques (report_id set) are not limited by the standalone key'
);

select throws_ok(
  $$ select pg_temp.insert_critique('a0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'critique-v1', 'cccccccc-0000-4000-8000-000000000001') $$,
  '23505', null,
  'report_id is unique'
);

select throws_ok(
  $$ insert into public.resume_critiques (resume_id, user_id, prompt_version, model, overall_score, summary, student_context, dimension_scores)
     values ('a0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'x', 'm', 101, 's', '{}', '[]') $$,
  '23514', null,
  'overall_score must be within 0..100'
);

select throws_ok(
  $$ insert into public.resume_critiques (resume_id, user_id, prompt_version, model, overall_score, summary, student_context, dimension_scores)
     values ('a0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'x', 'm', 50, 's', '{}', '{}') $$,
  '23514', null,
  'dimension_scores must be a JSON array'
);

select throws_ok(
  $$ insert into public.resume_critiques (resume_id, user_id, prompt_version, model, overall_score, summary, student_context, dimension_scores, dropped_items)
     values ('a0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'x', 'm', 50, 's', '{}', '[]', -1) $$,
  '23514', null,
  'dropped_items must be >= 0'
);

select is(
  (select line_feedback::text || section_feedback::text || ats_issues::text || missing_sections::text || dropped_items::text
     from public.resume_critiques where prompt_version = 'critique-v2'),
  '[][][][]0', 'list columns default to [] and dropped_items to 0'
);

-- ---------------------------------------------------------------------
-- Same-owner trigger
-- ---------------------------------------------------------------------

select throws_ok(
  $$ select pg_temp.insert_critique('a0000000-0000-4000-8000-0000000000a2', 'bbbbbbbb-0000-4000-8000-0000000000c2') $$,
  'P0001', 'validation_owner_mismatch',
  'inserting a critique of A''s resume with B''s user_id raises validation_owner_mismatch'
);

select throws_ok(
  $$ select pg_temp.insert_critique('dddddddd-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1') $$,
  'P0001', 'validation_owner_mismatch',
  'a critique of a missing resume raises validation_owner_mismatch (before the FK check)'
);

select throws_ok(
  $$ update public.resume_critiques set user_id = 'bbbbbbbb-0000-4000-8000-0000000000c2' where prompt_version = 'critique-v2' $$,
  'P0001', 'validation_owner_mismatch',
  'updating user_id away from the resume owner raises'
);

select throws_ok(
  $$ update public.resume_critiques set resume_id = 'b0000000-0000-4000-8000-0000000000b1' where prompt_version = 'critique-v2' $$,
  'P0001', 'validation_owner_mismatch',
  'moving a critique to another user''s resume raises'
);

-- The trigger fires only on writes to resume_id / user_id. Simulate a row
-- whose owner check would now fail (its resume temporarily belongs to B):
-- updating other columns, e.g. 0016's profile_id "on delete set null" during
-- account deletion, must still succeed; touching user_id must not.
update public.resumes set user_id = 'bbbbbbbb-0000-4000-8000-0000000000c2'
 where id = 'a0000000-0000-4000-8000-0000000000a1';

select lives_ok(
  $$ update public.resume_critiques set profile_id = null, summary = 'edited', dropped_items = 1
      where prompt_version = 'critique-v2' $$,
  'updating non-ownership columns does not fire the same-owner trigger'
);
select throws_ok(
  $$ update public.resume_critiques set user_id = user_id where prompt_version = 'critique-v2' $$,
  'P0001', 'validation_owner_mismatch',
  'any UPDATE OF user_id is still checked (even a no-op value)'
);

update public.resumes set user_id = 'aaaaaaaa-0000-4000-8000-0000000000c1'
 where id = 'a0000000-0000-4000-8000-0000000000a1';

select ok(
  (select pg_get_triggerdef(t.oid) like '%BEFORE INSERT OR UPDATE OF resume_id, user_id ON public.resume_critiques%'
     from pg_trigger t
    where t.tgrelid = 'public.resume_critiques'::regclass and t.tgname = 'resume_critiques_same_owner'),
  'the trigger is BEFORE INSERT OR UPDATE OF resume_id, user_id'
);

select is(
  (select prosecdef from pg_proc where oid = 'private.resume_critiques_same_owner()'::regprocedure),
  false, 'the trigger function is SECURITY INVOKER'
);
select ok(
  (select 'search_path=""' = any(proconfig) from pg_proc where oid = 'private.resume_critiques_same_owner()'::regprocedure),
  'the trigger function pins search_path to the empty string'
);
select ok(not has_function_privilege('anon', 'private.resume_critiques_same_owner()', 'execute'),
  'anon cannot execute the trigger function');
select ok(not has_function_privilege('authenticated', 'private.resume_critiques_same_owner()', 'execute'),
  'authenticated cannot execute the trigger function');

-- ---------------------------------------------------------------------
-- request_resume_critique: hardening and privileges
-- ---------------------------------------------------------------------

select is(
  (select prosecdef from pg_proc where oid = 'public.request_resume_critique(uuid)'::regprocedure),
  true, 'request_resume_critique is SECURITY DEFINER'
);
select ok(
  (select 'search_path=""' = any(proconfig) from pg_proc where oid = 'public.request_resume_critique(uuid)'::regprocedure),
  'request_resume_critique pins search_path to the empty string'
);
select ok(has_function_privilege('authenticated', 'public.request_resume_critique(uuid)', 'execute'),
  'authenticated can execute request_resume_critique');
select ok(not has_function_privilege('anon', 'public.request_resume_critique(uuid)', 'execute'),
  'anon cannot execute request_resume_critique');
select is(
  (select count(*)::int from information_schema.routine_privileges
    where routine_schema = 'public' and routine_name = 'request_resume_critique' and grantee = 'PUBLIC'),
  0, 'PUBLIC has no EXECUTE on request_resume_critique'
);

set local role anon;
do $$ begin perform pg_temp.as_user(null); end $$;
select throws_ok(
  $$ select public.request_resume_critique('a0000000-0000-4000-8000-0000000000a2') $$,
  '42501', null,
  'anon cannot call request_resume_critique'
);
select throws_ok(
  $$ select count(*) from public.resume_critiques $$,
  '42501', null,
  'anon cannot select resume_critiques'
);
select throws_ok(
  $$ select pg_temp.insert_critique('a0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'anon-forged') $$,
  '42501', null,
  'anon cannot insert resume_critiques'
);
reset role;

-- The service role (what the V1 route writes with) can insert, and the
-- same-owner trigger still guards it (RLS doesn't apply to service_role).
set local role service_role;
select lives_ok(
  $$ select pg_temp.insert_critique('a0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'svc-v1') $$,
  'service_role can insert a critique for the resume owner'
);
select throws_ok(
  $$ select pg_temp.insert_critique('a0000000-0000-4000-8000-0000000000a2', 'bbbbbbbb-0000-4000-8000-0000000000c2', 'svc-v2') $$,
  'P0001', 'validation_owner_mismatch',
  'service_role inserting with a mismatched user_id raises validation_owner_mismatch'
);
reset role;

-- ---------------------------------------------------------------------
-- request_resume_critique as users
-- ---------------------------------------------------------------------

set local role authenticated;
do $$ begin perform pg_temp.as_user(null); end $$;

select throws_ok(
  $$ select public.request_resume_critique('a0000000-0000-4000-8000-0000000000a2') $$,
  '42501', 'unauthenticated',
  'authenticated role without a JWT subject is refused (42501 unauthenticated)'
);

do $$ begin perform pg_temp.as_user('bbbbbbbb-0000-4000-8000-0000000000c2'); end $$;

select throws_ok(
  $$ select public.request_resume_critique('a0000000-0000-4000-8000-0000000000a2') $$,
  'P0001', 'not_found',
  'as B: A''s resume is not_found'
);
select throws_ok(
  $$ select public.request_resume_critique('dddddddd-0000-4000-8000-000000000001') $$,
  'P0001', 'not_found',
  'as B: a missing resume is not_found'
);
-- Counted as the owner (no RLS), so it can't pass just because B can't see
-- other users' ledger rows.
reset role;
select is(
  (select count(*)::int from public.rate_limit_events),
  0, 'not_found charges nothing (ledger counted without RLS)'
);
set local role authenticated;

do $$ begin perform pg_temp.as_user('aaaaaaaa-0000-4000-8000-0000000000c1'); end $$;

-- Five charges as A; the returned ids are kept in a transaction-local
-- setting (the role can't create tables) and compared in later statements.
do $$
declare
  v_ids text := '';
begin
  for i in 1..5 loop
    v_ids := v_ids || public.request_resume_critique('a0000000-0000-4000-8000-0000000000a2')::text || ',';
  end loop;
  perform set_config('kalify_test.critique_ids', rtrim(v_ids, ','), true);
end $$;

select is(
  (select count(distinct x)::int from unnest(string_to_array(current_setting('kalify_test.critique_ids'), ',')) x),
  5, 'as A: five calls succeed and return five distinct ids'
);

select throws_ok(
  $$ select public.request_resume_critique('a0000000-0000-4000-8000-0000000000a2') $$,
  'P0001', 'rate_limited:resume_report',
  'as A: the sixth call raises rate_limited:resume_report'
);

select set_eq(
  $$ select ref_id::text from public.rate_limit_events where kind = 'resume_report' $$,
  $$ select unnest(string_to_array(current_setting('kalify_test.critique_ids'), ',')) $$,
  'as A: each charge''s ref_id is the id the call returned (refund by ref_id)'
);

select is(
  (select count(*)::int from public.rate_limit_events where user_id = 'aaaaaaaa-0000-4000-8000-0000000000c1' and kind = 'resume_report' and refunded_at is null),
  5, 'as A: exactly five resume_report charges, all on A (the refused call charged nothing)'
);

select is(
  (select used_today from public.get_my_rate_limits() where kind = 'resume_report'),
  5, 'critiques share the resume_report quota shown by get_my_rate_limits'
);

-- RLS: A sees A's critiques and cannot write any.
select is(
  (select count(*)::int from public.resume_critiques),
  5, 'as A: A sees exactly A''s five critiques, incl. the service_role one (and the RPC inserted none)'
);
select throws_ok(
  $$ select pg_temp.insert_critique('a0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'forged') $$,
  '42501', null,
  'as A: inserting a critique directly is denied (no forged rows via PostgREST)'
);
select throws_ok(
  $$ update public.resume_critiques set overall_score = 100 $$,
  '42501', null,
  'as A: updating critiques is denied'
);
select throws_ok(
  $$ delete from public.resume_critiques $$,
  '42501', null,
  'as A: deleting critiques directly is denied'
);

do $$ begin perform pg_temp.as_user('bbbbbbbb-0000-4000-8000-0000000000c2'); end $$;

select is(
  (select count(*)::int from public.resume_critiques),
  0, 'as B: none of A''s critiques are visible'
);
select is(
  (select count(*)::int from public.resume_critiques where resume_id = 'a0000000-0000-4000-8000-0000000000a1'),
  0, 'as B: filtering on A''s resume id returns nothing'
);

select ok(
  public.request_resume_critique('b0000000-0000-4000-8000-0000000000b1') is not null,
  'as B: A''s exhausted quota does not affect B'
);

reset role;

select is(
  (select count(*)::int from public.rate_limit_events where user_id = 'bbbbbbbb-0000-4000-8000-0000000000c2'),
  1, 'B was charged exactly once, for B''s own call'
);

-- ---------------------------------------------------------------------
-- Cascade
-- ---------------------------------------------------------------------

select lives_ok(
  $$ select pg_temp.insert_critique('b0000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-0000000000c2') $$,
  'B gets a critique for the cascade checks'
);

delete from public.resumes where id = 'a0000000-0000-4000-8000-0000000000a1';

select is(
  (select count(*)::int from public.resume_critiques where resume_id = 'a0000000-0000-4000-8000-0000000000a1'),
  0, 'deleting a resume deletes its critiques'
);
select is(
  (select count(*)::int from public.resume_critiques where resume_id = 'b0000000-0000-4000-8000-0000000000b1'),
  1, 'other users'' critiques are untouched by that delete'
);

delete from auth.users where id = 'bbbbbbbb-0000-4000-8000-0000000000c2';

select is(
  (select count(*)::int from public.resume_critiques where user_id = 'bbbbbbbb-0000-4000-8000-0000000000c2'),
  0, 'deleting a user deletes their critiques'
);

select * from finish();
rollback;
