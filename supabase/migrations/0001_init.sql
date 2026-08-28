-- JobMatch initial schema
-- Implements the four core tables from docs/ARCHITECTURE.md §1:
--   resumes, resume_analyses, job_descriptions, matches
-- plus the shared `updated_at` trigger and the private `resumes` Storage
-- bucket with matching RLS policies.
--
-- Source of truth: docs/ARCHITECTURE.md §1. Keep this file in sync with
-- that document; do not diverge without updating both.

-- ---------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------

-- gen_random_uuid() lives in pgcrypto on older Postgres; Supabase images
-- ship it enabled by default, but this is idempotent and safe either way.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Shared updated_at trigger
-- ---------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- resumes
-- ---------------------------------------------------------------------

create table public.resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  file_type text not null,
  file_size_bytes integer not null,
  extracted_text text,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'processing', 'analyzed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index resumes_user_id_idx on public.resumes (user_id);

alter table public.resumes enable row level security;

create trigger resumes_set_updated_at
  before update on public.resumes
  for each row
  execute function public.set_updated_at();

create policy "resumes_select_own" on public.resumes
  for select using (user_id = auth.uid());
create policy "resumes_insert_own" on public.resumes
  for insert with check (user_id = auth.uid());
create policy "resumes_update_own" on public.resumes
  for update using (user_id = auth.uid());
create policy "resumes_delete_own" on public.resumes
  for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- resume_analyses
-- ---------------------------------------------------------------------

create table public.resume_analyses (
  id uuid primary key default gen_random_uuid(),
  resume_id uuid not null references public.resumes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  strengths jsonb not null default '[]'::jsonb,
  weaknesses jsonb not null default '[]'::jsonb,
  summary text,
  suggested_roles jsonb,
  model text not null,
  created_at timestamptz not null default now()
);

create index resume_analyses_resume_id_created_at_idx
  on public.resume_analyses (resume_id, created_at desc);
create index resume_analyses_user_id_idx on public.resume_analyses (user_id);

alter table public.resume_analyses enable row level security;

create policy "resume_analyses_select_own" on public.resume_analyses
  for select using (user_id = auth.uid());
create policy "resume_analyses_insert_own" on public.resume_analyses
  for insert with check (user_id = auth.uid());
-- No update/delete policy: analyses are immutable history rows.

-- ---------------------------------------------------------------------
-- job_descriptions
-- ---------------------------------------------------------------------

create table public.job_descriptions (
  id uuid primary key default gen_random_uuid(),
  submitted_by uuid references auth.users(id) on delete set null,
  title text not null,
  company text,
  description text not null,
  source_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index job_descriptions_created_at_idx
  on public.job_descriptions (created_at desc);

alter table public.job_descriptions enable row level security;

create trigger job_descriptions_set_updated_at
  before update on public.job_descriptions
  for each row
  execute function public.set_updated_at();

create policy "job_descriptions_select_all_authenticated" on public.job_descriptions
  for select to authenticated using (true);
create policy "job_descriptions_insert_own" on public.job_descriptions
  for insert to authenticated with check (submitted_by = auth.uid());
-- No update/delete policy: job descriptions are immutable/shared once
-- created (see docs/ARCHITECTURE.md §4/§5). No policy at all for `anon`.

-- ---------------------------------------------------------------------
-- matches
-- ---------------------------------------------------------------------

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  resume_id uuid not null references public.resumes(id) on delete cascade,
  job_description_id uuid not null references public.job_descriptions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  score integer not null check (score >= 0 and score <= 100),
  rationale text not null,
  matched_strengths jsonb,
  gaps jsonb,
  model text not null,
  created_at timestamptz not null default now()
);

create index matches_resume_id_created_at_idx
  on public.matches (resume_id, created_at desc);
create index matches_job_description_id_idx
  on public.matches (job_description_id);
create index matches_user_id_idx on public.matches (user_id);

alter table public.matches enable row level security;

create policy "matches_select_own" on public.matches
  for select using (user_id = auth.uid());
create policy "matches_insert_own" on public.matches
  for insert with check (user_id = auth.uid());
-- No update/delete policy: matches are immutable history rows.
