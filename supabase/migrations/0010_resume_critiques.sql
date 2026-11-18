-- Kalify v2 — resume critiques, created early for the visible-first V1
-- critique (docs/ARCHITECTURE.md §13.20.2; table spec §13.3.8).
--
-- Contents:
--   * public.resume_critiques                       (owner-select only)
--   * private.resume_critiques_same_owner() + trigger resume_critiques_same_owner
--   * public.request_resume_critique(uuid)          (authenticated user RPC)
--
-- Dependencies: 0001 (public.resumes) and 0007 (private.consume_rate_limit,
-- rate-limit kind 'resume_report'). It references nothing created by 0009,
-- and 0009 references nothing created here, so this file may be applied to
-- the live DB ahead of the parked 0009 (§13.3.0 "Application order
-- exception"); both orders give the same schema.
--
-- Deferred to 0016 (§13.3.8): the FKs resume_critiques.report_id ->
-- resume_reports(id) on delete cascade and resume_critiques.profile_id ->
-- resume_profiles(id) on delete set null. Those tables don't exist yet.
-- M3.9 drops request_resume_critique in its cleanup migration.
--
-- Conventions (§13.3, same as 0007):
--   * Every function: `set search_path = ''` and fully qualified names.
--   * EXECUTE explicitly revoked on every function; granted only where meant.
--   * Owner-only table: exactly one `for select to authenticated` policy, no
--     insert/update/delete privileges for anon/authenticated. Rows are
--     written by the service role only (§13.20.1 decision 9).
--
-- Forward-only. Never edit after it has been applied; add a new migration.

-- ---------------------------------------------------------------------
-- resume_critiques (owner-select only)
-- ---------------------------------------------------------------------

create table public.resume_critiques (
  id uuid primary key default gen_random_uuid(),
  report_id uuid null unique,          -- FK -> resume_reports(id) on delete cascade: added by 0016
  resume_id uuid not null references public.resumes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid null,                -- FK -> resume_profiles(id) on delete set null: added by 0016
  prompt_version text not null,
  model text not null,                 -- served model (response.model)
  overall_score integer not null check (overall_score between 0 and 100),
  summary text not null,
  student_context jsonb not null,
  dimension_scores jsonb not null check (jsonb_typeof(dimension_scores) = 'array'),
  line_feedback jsonb not null default '[]',
  section_feedback jsonb not null default '[]',
  ats_issues jsonb not null default '[]',
  missing_sections jsonb not null default '[]',
  dropped_items integer not null default 0 check (dropped_items >= 0),
  created_at timestamptz not null default now()
);

comment on table public.resume_critiques is
  'Resume critiques (docs/ARCHITECTURE.md §13.3.8, §13.20). Owner-select only; written by the service role. report_id is null for standalone V1 critiques. Private to the resume owner: never shared, never aggregated.';

create index resume_critiques_resume_id_created_at_idx on public.resume_critiques (resume_id, created_at desc);
create index resume_critiques_user_id_idx on public.resume_critiques (user_id);
-- Cache key for standalone (V1) critiques; report critiques are keyed by report_id.
create unique index resume_critiques_standalone_key
  on public.resume_critiques (resume_id, prompt_version) where report_id is null;

alter table public.resume_critiques enable row level security;

create policy "resume_critiques_select_own" on public.resume_critiques
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on table public.resume_critiques from anon, authenticated;
grant select on table public.resume_critiques to authenticated;

-- ---------------------------------------------------------------------
-- Same-owner guard (defense in depth for the service-role insert)
-- ---------------------------------------------------------------------

-- A critique's user_id must be the owner of its resume. The app already
-- sets user_id from the verified session and the resume was loaded with
-- that user's RLS-scoped client, but the insert itself runs as the service
-- role (RLS bypassed), so the database checks it again. A missing resume
-- (deleted concurrently) also fails this check.
create function private.resume_critiques_same_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.resumes r
    where r.id = new.resume_id
      and r.user_id = new.user_id
  ) then
    raise exception 'validation_owner_mismatch' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function private.resume_critiques_same_owner is
  'BEFORE INSERT OR UPDATE OF resume_id, user_id trigger on resume_critiques: raises validation_owner_mismatch unless resumes.user_id = new.user_id (docs/ARCHITECTURE.md §13.20.2). Not callable directly.';

-- Fires only when the ownership columns are written. Updates to other
-- columns (e.g. 0016's profile_id "on delete set null", run during account
-- deletion while the resume row may already be going away) must not be
-- re-checked, or a cascade could abort with validation_owner_mismatch.
create trigger resume_critiques_same_owner
  before insert or update of resume_id, user_id on public.resume_critiques
  for each row
  execute function private.resume_critiques_same_owner();

-- ---------------------------------------------------------------------
-- public.request_resume_critique (authenticated user RPC)
-- ---------------------------------------------------------------------

-- Charges one 'resume_report' unit to the CALLER for a critique of one of
-- the caller's own resumes, atomically (private.consume_rate_limit takes the
-- per-user+kind advisory lock). Returns the id the critique row will get, so
-- the ledger row's ref_id points at the critique (refund by ref_id,
-- §13.10.4). Inserts nothing else: the route inserts the critique through the
-- service role after the Claude call (§13.20.4).
create function public.request_resume_critique(p_resume_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.resumes r
    where r.id = p_resume_id
      and r.user_id = v_uid
  ) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  v_id := gen_random_uuid();

  if not private.consume_rate_limit(v_uid, 'resume_report', v_id) then
    raise exception 'rate_limited:resume_report' using errcode = 'P0001';
  end if;

  return v_id;
end;
$$;

comment on function public.request_resume_critique is
  'Charge one resume_report rate-limit unit to auth.uid() for a critique of the caller''s own resume; returns the future critique id (= the ledger ref_id). Raises unauthenticated (42501), not_found, rate_limited:resume_report (docs/ARCHITECTURE.md §13.20.2). Security definer. Dropped by M3.9.';

-- ---------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------

-- Trigger function: not callable by anyone (triggers fire without an
-- EXECUTE check).
revoke execute on function private.resume_critiques_same_owner() from public, anon, authenticated;

-- User RPC (authenticated only).
revoke execute on function public.request_resume_critique(uuid) from public, anon;
grant execute on function public.request_resume_critique(uuid) to authenticated;
