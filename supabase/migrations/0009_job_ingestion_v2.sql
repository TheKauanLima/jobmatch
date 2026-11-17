-- Kalify v2 — job ingestion v2 core (milestone M1.5).
--
-- Implements docs/ARCHITECTURE.md §13.3.3 (with §13.6.4–13.6.6):
--   * public.job_descriptions v2 columns and constraints (visibility/owner,
--     source attribution, freshness/expiry, cross-source dedupe, content_hash)
--   * content_hash trigger (job_descriptions_content_hash) and the
--     shared → private guard trigger (job_descriptions_guard)
--   * RLS rewrite: one SELECT policy (shared, or the caller's own private
--     rows); every direct write from anon/authenticated revoked
--   * user RPCs (authenticated, SECURITY DEFINER, auth.uid() first, rate
--     limited through private.consume_rate_limit):
--       create_job_listing, update_job_listing, delete_job_listing
--   * public.search_job_descriptions v2 (scope 'shared' | 'mine')
--   * public.job_sources (seeded), public.job_source_boards,
--     public.job_source_runs                          (server-only)
--   * enqueue_source_syncs, expire_stale_job_descriptions,
--     resolve_job_duplicates                          (service_role only)
--   * cron jobs (UTC):
--       kalify-expire-jobs   30 12 * * *   public.expire_stale_job_descriptions()
--       kalify-ingest        0 13 * * *    public.enqueue_source_syncs()
--     pg_cron is now the single ingest scheduler; the vercel.json cron entry
--     is removed in the same milestone.
--
-- Backfill: content_hash is filled for existing rows here (the trigger
-- fires on `set title = title`). dedupe_key / last_seen_at / expires_at
-- for existing external rows are backfilled by the background task
-- `maintenance.backfill_job_keys` (TS normalization), not in SQL (§13.3.3).
--
-- Conventions (§13.3, as in 0007):
--   * Every function: `set search_path = ''` and fully qualified names.
--   * Every function gets an explicit `revoke execute ... from public, anon,
--     authenticated` (Postgres and Supabase grant EXECUTE by default) plus a
--     grant only where intended: service_role for internal functions,
--     authenticated for the user RPCs.
--   * Server-only tables: RLS on, no policies, privileges revoked from
--     anon/authenticated.
--
-- Advisory lock namespaces (two-key pg_advisory_xact_lock(int4, int4)).
-- 0007 declared 410701 (claim_tasks) and 410702 (consume_rate_limit); 0007
-- is applied and can't be edited, so this migration declares its own:
--   410901  resolve_job_duplicates, keyed by hashtext(dedupe_key)
-- Any future lock user must add a new constant in its own migration and
-- list it in its header the same way.
--
-- Forward-only. Never edit after it has been applied; add a new migration.

-- ---------------------------------------------------------------------
-- job_descriptions: v2 columns
-- ---------------------------------------------------------------------

alter table public.job_descriptions
  add column visibility text not null default 'shared'
    check (visibility in ('shared', 'private')),
  -- Non-null iff private (constraint below). Separate from submitted_by,
  -- which stays `on delete set null` so shared rows survive account
  -- deletion anonymized; private rows are deleted with their owner.
  add column owner_user_id uuid references auth.users(id) on delete cascade,
  add column source_board text,
  add column apply_url text,
  add column employment_type text,
  add column remote_type text
    check (remote_type is null or remote_type in ('onsite', 'hybrid', 'remote')),
  add column location_country text,
  add column salary_min numeric,
  add column salary_max numeric,
  add column salary_currency text,
  add column salary_period text
    check (salary_period is null or salary_period in ('hour', 'year', 'month')),
  add column last_seen_at timestamptz,
  add column expires_at timestamptz,
  add column closed_at timestamptz,
  add column closed_reason text
    check (closed_reason is null or closed_reason in ('expired', 'removed_at_source', 'manual')),
  -- Added nullable, backfilled below, then set NOT NULL.
  add column content_hash text,
  add column dedupe_key text,
  add column duplicate_of uuid references public.job_descriptions(id) on delete set null,
  add column source_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_metadata) = 'object');

comment on column public.job_descriptions.visibility is
  '''shared'' (any authenticated user can read and match it) or ''private'' (only owner_user_id). External rows are always shared. private -> shared is allowed (update_job_listing); shared -> private never (job_descriptions_guard). docs/ARCHITECTURE.md §13.2.1, §13.3.3.';
comment on column public.job_descriptions.owner_user_id is
  'Owner of a PRIVATE listing (non-null iff visibility = ''private''); on delete cascade removes private listings with the account. Distinct from submitted_by (on delete set null, keeps shared rows anonymized).';
comment on column public.job_descriptions.source_board is
  'Greenhouse board token / Lever site for board sources; null otherwise.';
comment on column public.job_descriptions.apply_url is
  'Direct apply link when the source provides one; the UI falls back to source_url.';
comment on column public.job_descriptions.employment_type is
  'Source vocabulary (e.g. ''Full-time''); the normalized value lives in job_requirements (§13.3.6).';
comment on column public.job_descriptions.remote_type is
  '''onsite'' | ''hybrid'' | ''remote'' when the source states it explicitly; null otherwise.';
comment on column public.job_descriptions.location_country is
  'ISO-3166 alpha-2 country code when known.';
comment on column public.job_descriptions.salary_currency is
  'ISO-4217 currency code when the source gives a salary.';
comment on column public.job_descriptions.last_seen_at is
  'Last sync that returned this listing (every upsert bumps it, changed or not). Null for user rows.';
comment on column public.job_descriptions.expires_at is
  'When the daily sweep (expire_stale_job_descriptions) closes the row: coalesce(source close date, greatest(posted_at, last_seen_at) + job_sources.default_ttl_days) for external rows; created_at + 60 days (extended by editing) for shared user rows; null for private rows (never auto-expire). §13.6.5.';
comment on column public.job_descriptions.closed_at is
  'Set by the expiry sweep or a snapshot diff. Closed rows stay (fit checks reference them) but leave browse/search/retrieval/stats. Resolves by id.';
comment on column public.job_descriptions.content_hash is
  'sha256 hex of title || E''\n'' || coalesce(company, '''') || E''\n'' || description. Maintained by the job_descriptions_content_hash trigger; never written by app code. Drives re-extraction (§13.3.6).';
comment on column public.job_descriptions.dedupe_key is
  'Cross-source dedupe key computed in TS (lib/jobs/normalize.ts, §13.6.4); external rows only (user rows are never merged).';
comment on column public.job_descriptions.duplicate_of is
  'Non-null = hidden duplicate of the canonical row with the same dedupe_key (resolve_job_duplicates). Still resolves by id.';
comment on column public.job_descriptions.source_metadata is
  'Small raw source fields worth keeping (department, team, schedule). Never resume data.';

-- §13.3.3: replace the 0004 source check (generated name, expected
-- `job_descriptions_source_check`). Found by definition rather than by name
-- so a differently named constraint can't survive and block new sources;
-- fails loudly if nothing matched.
do $$
declare
  v_name text;
  v_dropped integer := 0;
begin
  for v_name in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.job_descriptions'::regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%source%'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%themuse%'
  loop
    execute format('alter table public.job_descriptions drop constraint %I', v_name);
    v_dropped := v_dropped + 1;
  end loop;

  if v_dropped <> 1 then
    raise exception 'expected exactly one existing job_descriptions source check constraint, found %', v_dropped;
  end if;
end;
$$;

alter table public.job_descriptions
  add constraint job_descriptions_source_check
    check (source in ('user', 'themuse', 'usajobs', 'greenhouse', 'lever', 'adzuna')),
  add constraint job_descriptions_visibility_owner_check
    check ((visibility = 'private') = (owner_user_id is not null)),
  add constraint job_descriptions_private_user_only_check
    check (visibility = 'shared' or source = 'user'),
  add constraint job_descriptions_closed_reason_required_check
    check (closed_at is null or closed_reason is not null),
  -- §13.6.4: user-submitted rows are never dedupe-merged.
  add constraint job_descriptions_user_rows_not_deduped_check
    check (source <> 'user' or (dedupe_key is null and duplicate_of is null)),
  add constraint job_descriptions_duplicate_of_not_self_check
    check (duplicate_of is null or duplicate_of <> id);

-- ---------------------------------------------------------------------
-- job_descriptions: content_hash trigger + backfill
-- ---------------------------------------------------------------------

-- Always recomputed, so app code can never set it (a written value is
-- overwritten). BEFORE triggers run before NOT NULL checks, so inserts that
-- omit content_hash succeed.
create function public.job_descriptions_set_content_hash()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.content_hash := encode(
    sha256(convert_to(new.title || E'\n' || coalesce(new.company, '') || E'\n' || new.description, 'UTF8')),
    'hex'
  );
  return new;
end;
$$;

comment on function public.job_descriptions_set_content_hash is
  'BEFORE INSERT OR UPDATE trigger on job_descriptions: recomputes content_hash (docs/ARCHITECTURE.md §13.3.3). Not callable directly.';

create trigger job_descriptions_content_hash
  before insert or update on public.job_descriptions
  for each row
  execute function public.job_descriptions_set_content_hash();

-- Backfill content_hash for existing rows (§13.3.3: `set title = title`
-- fires the trigger). set_updated_at is disabled for this one statement so
-- the backfill doesn't rewrite every row's updated_at:
-- maintenance.backfill_job_keys derives last_seen_at from updated_at
-- (= the last v1 sync that returned the row).
alter table public.job_descriptions disable trigger job_descriptions_set_updated_at;
update public.job_descriptions set title = title;
alter table public.job_descriptions enable trigger job_descriptions_set_updated_at;

alter table public.job_descriptions alter column content_hash set not null;

-- ---------------------------------------------------------------------
-- job_descriptions: guard trigger (defense in depth for service-role paths)
-- ---------------------------------------------------------------------

-- shared -> private is never allowed (§13.2.1 rule 2): other users' fit
-- checks and recommendations may already reference the listing. The RPCs
-- check this too; the trigger also covers service-role code paths.
create function public.job_descriptions_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.visibility = 'shared' and new.visibility = 'private' then
    raise exception 'visibility_downgrade' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.job_descriptions_guard is
  'BEFORE UPDATE trigger on job_descriptions: raises visibility_downgrade on shared -> private (docs/ARCHITECTURE.md §13.3.3). Not callable directly.';

create trigger job_descriptions_guard
  before update on public.job_descriptions
  for each row
  execute function public.job_descriptions_guard();

-- ---------------------------------------------------------------------
-- job_descriptions: indexes
-- ---------------------------------------------------------------------

-- Browse (scope=shared keyset listing).
create index job_descriptions_active_shared_idx
  on public.job_descriptions (created_at desc, id desc)
  where visibility = 'shared' and deleted_at is null and closed_at is null and duplicate_of is null;

create index job_descriptions_dedupe_key_idx
  on public.job_descriptions (dedupe_key)
  where dedupe_key is not null and closed_at is null;

create index job_descriptions_owner_user_id_idx
  on public.job_descriptions (owner_user_id)
  where owner_user_id is not null;

create index job_descriptions_source_board_last_seen_idx
  on public.job_descriptions (source, source_board, last_seen_at);

create index job_descriptions_expires_at_idx
  on public.job_descriptions (expires_at)
  where closed_at is null;

-- Not in the §13.3.3 list; supporting indexes only:
-- * the `on delete set null` self-FK (same reason as 0007's
--   background_tasks_parent_task_id_idx);
create index job_descriptions_duplicate_of_idx
  on public.job_descriptions (duplicate_of)
  where duplicate_of is not null;
-- * scope=mine keyset listing (`submitted_by = auth.uid()` ordered like browse).
create index job_descriptions_submitted_by_created_at_idx
  on public.job_descriptions (submitted_by, created_at desc, id desc)
  where submitted_by is not null;

-- ---------------------------------------------------------------------
-- job_descriptions: RLS rewrite + revoke direct writes
-- ---------------------------------------------------------------------

drop policy "job_descriptions_select_all_authenticated" on public.job_descriptions;
drop policy "job_descriptions_insert_own" on public.job_descriptions;
drop policy "job_descriptions_update_own" on public.job_descriptions;

create policy "job_descriptions_select_visible" on public.job_descriptions
  for select to authenticated
  using (visibility = 'shared' or owner_user_id = (select auth.uid()));

-- All authenticated writes go through the security-definer RPCs below
-- (ownership, visibility rules, rate limits). §13.3.3 revokes insert,
-- update and delete; truncate/references/trigger are revoked as well since
-- Supabase's default privileges grant ALL and TRUNCATE ignores RLS.
revoke insert, update, delete, truncate, references, trigger
  on public.job_descriptions from anon, authenticated;

-- ---------------------------------------------------------------------
-- User RPCs (authenticated): create / update / delete listing
-- ---------------------------------------------------------------------
-- Field limits duplicate lib/validation/schemas.ts (the route validates
-- with zod first; these are the authoritative server-side checks):
--   JOB_DESCRIPTION_TITLE_MAX_LENGTH        200
--   JOB_DESCRIPTION_COMPANY_MAX_LENGTH      200
--   JOB_DESCRIPTION_DESCRIPTION_MAX_LENGTH  20000
--   JOB_DESCRIPTION_SOURCE_URL_MAX_LENGTH   2048
--   JOB_DESCRIPTION_LOCATION_MAX_LENGTH     200
--   JOB_DESCRIPTION_LEVELS                  Internship, Entry Level, Mid Level, Senior Level, Management
-- Keep both in sync (lib/validation/schemas.test.ts asserts it against this
-- file). Errors use the §13.13 RPC format: validation_* -> 400,
-- rate_limited:<kind> -> 429, not_found* -> 404, visibility_downgrade -> 400.

-- private.validate_job_listing_fields --------------------------------
-- Shared validation for create/update. Takes already-trimmed values (empty
-- optional strings already turned into null by the caller).
create function private.validate_job_listing_fields(
  p_title text,
  p_company text,
  p_description text,
  p_source_url text,
  p_location text,
  p_level text
)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_title is null or char_length(p_title) = 0 or char_length(p_title) > 200 then
    raise exception 'validation_title' using errcode = 'P0001';
  end if;
  if p_description is null or char_length(p_description) = 0 or char_length(p_description) > 20000 then
    raise exception 'validation_description' using errcode = 'P0001';
  end if;
  if p_company is not null and char_length(p_company) > 200 then
    raise exception 'validation_company' using errcode = 'P0001';
  end if;
  if p_source_url is not null
     and (char_length(p_source_url) > 2048 or p_source_url !~* '^https?://[^[:space:]]+$') then
    raise exception 'validation_source_url' using errcode = 'P0001';
  end if;
  if p_location is not null and char_length(p_location) > 200 then
    raise exception 'validation_location' using errcode = 'P0001';
  end if;
  if p_level is not null
     and p_level not in ('Internship', 'Entry Level', 'Mid Level', 'Senior Level', 'Management') then
    raise exception 'validation_level' using errcode = 'P0001';
  end if;
end;
$$;

comment on function private.validate_job_listing_fields is
  'Internal: field checks shared by create_job_listing / update_job_listing (limits mirror lib/validation/schemas.ts). Raises validation_<field>.';

-- public.create_job_listing ------------------------------------------
create function public.create_job_listing(
  p_title text,
  p_company text,
  p_description text,
  p_source_url text,
  p_location text,
  p_level text,
  p_visibility text
)
returns public.job_descriptions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid := gen_random_uuid();
  v_title text := btrim(p_title);
  v_company text := nullif(btrim(p_company), '');
  v_description text := btrim(p_description);
  v_source_url text := nullif(btrim(p_source_url), '');
  v_location text := nullif(btrim(p_location), '');
  v_level text := nullif(btrim(p_level), '');
  v_row public.job_descriptions;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_visibility is null or p_visibility not in ('shared', 'private') then
    raise exception 'validation_visibility' using errcode = 'P0001';
  end if;

  perform private.validate_job_listing_fields(
    v_title, v_company, v_description, v_source_url, v_location, v_level
  );

  -- Charged only after validation passes, with the new listing's id as
  -- ref_id (for refunds).
  if not private.consume_rate_limit(v_uid, 'job_listing_create', v_id) then
    raise exception 'rate_limited:job_listing_create' using errcode = 'P0001';
  end if;

  insert into public.job_descriptions (
    id, submitted_by, owner_user_id, visibility, source,
    title, company, description, source_url, location, level, expires_at
  ) values (
    v_id,
    v_uid,
    case when p_visibility = 'private' then v_uid end,
    p_visibility,
    'user',
    v_title,
    v_company,
    v_description,
    v_source_url,
    v_location,
    v_level,
    -- Shared user rows expire after 60 days (§13.6.5); private never.
    case when p_visibility = 'shared' then now() + interval '60 days' end
  )
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.create_job_listing is
  'User RPC (authenticated): submit a job listing as auth.uid() with an explicit visibility; consumes job_listing_create (docs/ARCHITECTURE.md §13.3.3, §13.13.4). Raises unauthenticated (42501), validation_*, rate_limited:job_listing_create.';

-- public.update_job_listing ------------------------------------------
-- Only the caller's own source='user' rows. Allowed patch keys: title,
-- company, description, source_url, location, level, visibility. Consumes
-- job_listing_update only when content_hash changes. visibility may go
-- private -> shared (owner_user_id cleared, 60-day expiry starts) but never
-- shared -> private. Any successful edit of a shared row extends expires_at
-- to now() + 60 days (§13.6.5 "the submitter can extend it by editing").
create function public.update_job_listing(
  p_id uuid,
  p_patch jsonb
)
returns public.job_descriptions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.job_descriptions;
  v_key text;
  v_title text;
  v_company text;
  v_description text;
  v_source_url text;
  v_location text;
  v_level text;
  v_visibility text;
  v_new_hash text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'validation_patch_empty' using errcode = 'P0001';
  end if;

  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('title', 'company', 'description', 'source_url', 'location', 'level', 'visibility') then
      raise exception 'validation_patch_unknown_key' using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_patch -> v_key) not in ('string', 'null') then
      raise exception 'validation_%', v_key using errcode = 'P0001';
    end if;
  end loop;

  -- Ownership first (§13.15 item 2). A private row of another user and a
  -- shared row submitted by someone else look the same here; the route
  -- tells them apart (404 vs 403) with an RLS-scoped read beforehand.
  select * into v_row
  from public.job_descriptions jd
  where jd.id = p_id
    and jd.submitted_by = v_uid
    and jd.source = 'user'
  for update;

  if not found then
    raise exception 'not_found_or_not_owner' using errcode = 'P0001';
  end if;

  v_title := case when p_patch ? 'title' then btrim(p_patch ->> 'title') else v_row.title end;
  v_company := case when p_patch ? 'company' then nullif(btrim(p_patch ->> 'company'), '') else v_row.company end;
  v_description := case when p_patch ? 'description' then btrim(p_patch ->> 'description') else v_row.description end;
  v_source_url := case when p_patch ? 'source_url' then nullif(btrim(p_patch ->> 'source_url'), '') else v_row.source_url end;
  v_location := case when p_patch ? 'location' then nullif(btrim(p_patch ->> 'location'), '') else v_row.location end;
  v_level := case when p_patch ? 'level' then nullif(btrim(p_patch ->> 'level'), '') else v_row.level end;
  v_visibility := case when p_patch ? 'visibility' then p_patch ->> 'visibility' else v_row.visibility end;

  if v_visibility is null or v_visibility not in ('shared', 'private') then
    raise exception 'validation_visibility' using errcode = 'P0001';
  end if;
  if v_row.visibility = 'shared' and v_visibility = 'private' then
    raise exception 'visibility_downgrade' using errcode = 'P0001';
  end if;

  perform private.validate_job_listing_fields(
    v_title, v_company, v_description, v_source_url, v_location, v_level
  );

  -- Same expression as job_descriptions_set_content_hash.
  v_new_hash := encode(
    sha256(convert_to(v_title || E'\n' || coalesce(v_company, '') || E'\n' || v_description, 'UTF8')),
    'hex'
  );

  if v_new_hash is distinct from v_row.content_hash then
    if not private.consume_rate_limit(v_uid, 'job_listing_update', p_id) then
      raise exception 'rate_limited:job_listing_update' using errcode = 'P0001';
    end if;
  end if;

  update public.job_descriptions jd
  set title = v_title,
      company = v_company,
      description = v_description,
      source_url = v_source_url,
      location = v_location,
      level = v_level,
      visibility = v_visibility,
      owner_user_id = case when v_visibility = 'private' then v_uid end,
      expires_at = case when v_visibility = 'shared' then now() + interval '60 days' end
  where jd.id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.update_job_listing is
  'User RPC (authenticated): edit the caller''s own user-submitted listing; consumes job_listing_update only when content_hash changes; private -> shared allowed, shared -> private raises visibility_downgrade (docs/ARCHITECTURE.md §13.3.3, §13.13.4). Raises unauthenticated (42501), validation_*, not_found_or_not_owner, rate_limited:job_listing_update.';

-- public.delete_job_listing ------------------------------------------
-- Private + owner -> hard delete (cascade removes the owner's own fit
-- checks/recommendations), returns 'deleted'. Shared + submitter -> soft
-- delete (deleted_at; other users' matches keep resolving), returns
-- 'soft_deleted'. Idempotent for shared rows.
create function public.delete_job_listing(p_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.job_descriptions;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_row
  from public.job_descriptions jd
  where jd.id = p_id
    and jd.submitted_by = v_uid
    and jd.source = 'user'
  for update;

  if not found then
    raise exception 'not_found_or_not_owner' using errcode = 'P0001';
  end if;

  if v_row.visibility = 'private' then
    delete from public.job_descriptions jd
    where jd.id = p_id
      and jd.owner_user_id = v_uid;
    return 'deleted';
  end if;

  update public.job_descriptions jd
  set deleted_at = coalesce(jd.deleted_at, now())
  where jd.id = p_id;
  return 'soft_deleted';
end;
$$;

comment on function public.delete_job_listing is
  'User RPC (authenticated): delete the caller''s own user-submitted listing. Private -> hard delete (''deleted''); shared -> soft delete (''soft_deleted'') (docs/ARCHITECTURE.md §13.3.3, §13.13.4). Raises unauthenticated (42501), not_found_or_not_owner.';

-- ---------------------------------------------------------------------
-- search_job_descriptions v2
-- ---------------------------------------------------------------------
-- SECURITY INVOKER: RLS applies (private rows of other users are never
-- visible). Keeps the §9 ranking, adds the scope and the active predicate.
--   scope 'shared': visibility = 'shared' (excludes ALL private rows,
--                   including the caller's own) and active
--   scope 'mine':   submitted_by = auth.uid() (shared + private, closed and
--                   soft-deleted included), duplicate_of is null
-- Any other scope raises validation_scope.

drop function public.search_job_descriptions(text, text, integer, integer);

create function public.search_job_descriptions(
  search_query text,
  level_filter text default null,
  scope text default 'shared',
  limit_count integer default 20,
  offset_count integer default 0
)
returns setof public.job_descriptions
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if scope is null or scope not in ('shared', 'mine') then
    raise exception 'validation_scope' using errcode = 'P0001';
  end if;

  return query
  select jd.*
  from public.job_descriptions jd
  where jd.search_vector @@ websearch_to_tsquery('english', search_query)
    and (level_filter is null or jd.level = level_filter)
    and jd.duplicate_of is null
    and (
      (scope = 'shared'
        and jd.visibility = 'shared'
        and jd.deleted_at is null
        and jd.closed_at is null)
      or
      (scope = 'mine'
        and jd.submitted_by = (select auth.uid()))
    )
  order by
    ts_rank(jd.search_vector, websearch_to_tsquery('english', search_query)) desc,
    jd.created_at desc,
    jd.id desc
  limit limit_count
  offset offset_count;
end;
$$;

comment on function public.search_job_descriptions is
  'Ranked full-text search over job_descriptions (GET /api/job-descriptions?q=), docs/ARCHITECTURE.md §9, §13.3.3. scope ''shared'' = active shared listings; scope ''mine'' = everything the caller submitted except duplicates. SECURITY INVOKER (RLS applies). Offset pagination (§9.2).';

-- ---------------------------------------------------------------------
-- job_sources (server-only, seeded)
-- ---------------------------------------------------------------------

create table public.job_sources (
  slug text primary key
    check (slug in ('themuse', 'usajobs', 'greenhouse', 'lever', 'adzuna')),
  display_name text not null,
  enabled boolean not null default false,
  -- 'snapshot' sources (Greenhouse/Lever) are board sources: one sync per
  -- enabled job_source_boards row, and a complete fetch closes listings no
  -- longer on the board. 'incremental' sources sync once, without a board.
  sync_mode text not null
    check (sync_mode in ('snapshot', 'incremental')),
  -- Lower wins canonical in resolve_job_duplicates.
  dedupe_priority smallint not null,
  default_ttl_days integer not null
    check (default_ttl_days > 0),
  config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config) = 'object'),
  last_run_at timestamptz,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.job_sources is
  'External job sources and their sync settings (docs/ARCHITECTURE.md §13.3.3, §13.6). Server-only: RLS on, no policies.';

create trigger job_sources_set_updated_at
  before update on public.job_sources
  for each row
  execute function public.set_updated_at();

alter table public.job_sources enable row level security;
-- Server-only: deliberately no policies.
revoke all on table public.job_sources from anon, authenticated;

insert into public.job_sources (slug, display_name, enabled, sync_mode, dedupe_priority, default_ttl_days, config) values
  -- The Muse: max_pages_per_level moved here from lib/jobs/sync.ts
  -- (MAX_PAGES_PER_LEVEL = 5 in v1).
  ('themuse', 'The Muse', true, 'incremental', 30, 60,
    '{"levels": ["Internship", "Entry Level"], "max_pages_per_level": 5}'::jsonb),
  -- USAJOBS closes via ApplicationCloseDate; 60 days is the backstop.
  ('usajobs', 'USAJOBS', false, 'incremental', 20, 60, '{}'::jsonb),
  ('greenhouse', 'Greenhouse', false, 'snapshot', 10, 90, '{}'::jsonb),
  ('lever', 'Lever', false, 'snapshot', 10, 90, '{}'::jsonb),
  ('adzuna', 'Adzuna', false, 'incremental', 40, 45, '{}'::jsonb)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- job_source_boards (server-only)
-- ---------------------------------------------------------------------

create table public.job_source_boards (
  id uuid primary key default gen_random_uuid(),
  source_slug text not null references public.job_sources(slug) on delete cascade,
  board_token text not null
    check (char_length(board_token) between 1 and 200),
  company_name text,
  enabled boolean not null default true,
  -- §13.6.3: also keep titles that match neither the student nor the
  -- senior pattern.
  include_unlabeled_titles boolean not null default false,
  last_synced_at timestamptz,
  last_error_code text
    check (last_error_code is null or char_length(last_error_code) <= 64),
  -- The sync sets enabled = false after 5 consecutive failures.
  consecutive_failures integer not null default 0
    check (consecutive_failures >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_slug, board_token)
);

comment on table public.job_source_boards is
  'Per-company boards for snapshot sources (Greenhouse board tokens, Lever sites), docs/ARCHITECTURE.md §13.3.3. Server-only: RLS on, no policies.';

create trigger job_source_boards_set_updated_at
  before update on public.job_source_boards
  for each row
  execute function public.set_updated_at();

alter table public.job_source_boards enable row level security;
-- Server-only: deliberately no policies.
revoke all on table public.job_source_boards from anon, authenticated;

-- ---------------------------------------------------------------------
-- job_source_runs (server-only)
-- ---------------------------------------------------------------------

create table public.job_source_runs (
  id uuid primary key default gen_random_uuid(),
  source_slug text not null references public.job_sources(slug) on delete cascade,
  board_id uuid references public.job_source_boards(id) on delete set null,
  -- The task that started the run; continuation tasks carry the run id in
  -- their payload. Purged tasks leave this null.
  task_id uuid references public.background_tasks(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'partial', 'failed')),
  fetched integer not null default 0 check (fetched >= 0),
  inserted integer not null default 0 check (inserted >= 0),
  updated integer not null default 0 check (updated >= 0),
  unchanged integer not null default 0 check (unchanged >= 0),
  closed integer not null default 0 check (closed >= 0),
  skipped_filtered integer not null default 0 check (skipped_filtered >= 0),
  skipped_invalid integer not null default 0 check (skipped_invalid >= 0),
  -- No PII; listing text is never logged or stored here.
  error_summary text
    check (error_summary is null or char_length(error_summary) <= 500)
);

comment on table public.job_source_runs is
  'One row per source/board sync run with per-run counts (docs/ARCHITECTURE.md §13.3.3, §13.6.6). Server-only. error_summary never contains listing text.';

create index job_source_runs_source_started_at_idx
  on public.job_source_runs (source_slug, started_at desc);

create index job_source_runs_task_id_idx
  on public.job_source_runs (task_id);

create index job_source_runs_board_id_idx
  on public.job_source_runs (board_id);

alter table public.job_source_runs enable row level security;
-- Server-only: deliberately no policies.
revoke all on table public.job_source_runs from anon, authenticated;

-- ---------------------------------------------------------------------
-- Ingest functions (service_role only)
-- ---------------------------------------------------------------------
-- SECURITY INVOKER: callers are pg_cron (postgres) and the worker
-- (service_role), which already hold the table privileges.

-- enqueue_source_syncs ------------------------------------------------
-- One ingest.sync_source task per enabled incremental source, and one per
-- enabled board of each enabled snapshot source. dedupe_key per §13.3.3
-- (the date is the UTC date, which is current_date on Supabase).
-- Task parameters duplicate lib/tasks/registry.ts `ingest.sync_source`
-- (class background, priority 10, max attempts 4, lease 270 s);
-- lib/tasks/registry.test.ts asserts they match. Returns the number of
-- syncs requested (existing live tasks with the same key count too).
create function public.enqueue_source_syncs()
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_today text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  v_source record;
  v_board record;
  v_count integer := 0;
begin
  for v_source in
    select s.slug, s.sync_mode
    from public.job_sources s
    where s.enabled
    order by s.slug
  loop
    if v_source.sync_mode = 'snapshot' then
      for v_board in
        select b.id, b.board_token
        from public.job_source_boards b
        where b.source_slug = v_source.slug
          and b.enabled
        order by b.board_token
      loop
        perform public.enqueue_task(
          p_kind => 'ingest.sync_source',
          p_task_class => 'background',
          p_payload => jsonb_build_object('source', v_source.slug, 'boardId', v_board.id),
          p_dedupe_key => 'ingest:' || v_source.slug || ':' || v_board.board_token || ':' || v_today,
          p_priority => 10,
          p_max_attempts => 4,
          p_lease_seconds => 270
        );
        v_count := v_count + 1;
      end loop;
    else
      perform public.enqueue_task(
        p_kind => 'ingest.sync_source',
        p_task_class => 'background',
        p_payload => jsonb_build_object('source', v_source.slug),
        p_dedupe_key => 'ingest:' || v_source.slug || ':-:' || v_today,
        p_priority => 10,
        p_max_attempts => 4,
        p_lease_seconds => 270
      );
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

comment on function public.enqueue_source_syncs is
  'Enqueue today''s ingest.sync_source tasks: one per enabled incremental source, one per enabled board of each enabled snapshot source (docs/ARCHITECTURE.md §13.3.3). Idempotent per UTC day via dedupe_key. Scheduled by kalify-ingest. service_role only.';

-- expire_stale_job_descriptions ---------------------------------------
-- Daily sweep (§13.6.5): closes every open shared listing past expires_at.
-- Private rows have no expires_at and never expire automatically; the
-- visibility filter makes that explicit.
create function public.expire_stale_job_descriptions()
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.job_descriptions jd
  set closed_at = now(),
      closed_reason = 'expired'
  where jd.closed_at is null
    and jd.expires_at <= now()
    and jd.visibility = 'shared';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.expire_stale_job_descriptions is
  'Close shared listings whose expires_at has passed (closed_reason ''expired''), docs/ARCHITECTURE.md §13.3.3, §13.6.5. Returns the number closed. Scheduled by kalify-expire-jobs. service_role only.';

-- resolve_job_duplicates ----------------------------------------------
-- For each dedupe key: the canonical row is the ACTIVE (not soft-deleted,
-- not closed) shared external row with the lowest job_sources.dedupe_priority,
-- then earliest posted_at (nulls last), then id. Canonical gets
-- duplicate_of = null; every other row with that key gets
-- duplicate_of = canonical.id. When no row of a key is active, all rows of
-- that key get duplicate_of = null. Idempotent; writes only rows that
-- change. Keys are locked in sorted order (namespace 410901) so concurrent
-- syncs of different sources can't interleave on the same key or deadlock.
-- Returns the number of rows changed.
create function public.resolve_job_duplicates(p_dedupe_keys text[])
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_key text;
  v_canonical uuid;
  v_changed integer;
  v_total integer := 0;
begin
  if p_dedupe_keys is null then
    return 0;
  end if;

  for v_key in
    select distinct k
    from unnest(p_dedupe_keys) as k
    where k is not null
    order by k
  loop
    perform pg_advisory_xact_lock(410901, hashtext(v_key));

    select jd.id into v_canonical
    from public.job_descriptions jd
    left join public.job_sources s on s.slug = jd.source
    where jd.dedupe_key = v_key
      and jd.deleted_at is null
      and jd.closed_at is null
      and jd.visibility = 'shared'
      and jd.source <> 'user'
    order by coalesce(s.dedupe_priority, 32767), jd.posted_at asc nulls last, jd.id
    limit 1;

    if v_canonical is null then
      update public.job_descriptions jd
      set duplicate_of = null
      where jd.dedupe_key = v_key
        and jd.duplicate_of is not null;
      get diagnostics v_changed = row_count;
    else
      update public.job_descriptions jd
      set duplicate_of = case when jd.id = v_canonical then null else v_canonical end
      where jd.dedupe_key = v_key
        and jd.duplicate_of is distinct from (case when jd.id = v_canonical then null else v_canonical end);
      get diagnostics v_changed = row_count;
    end if;

    v_total := v_total + v_changed;
  end loop;

  return v_total;
end;
$$;

comment on function public.resolve_job_duplicates is
  'Mark one canonical row per dedupe_key (lowest job_sources.dedupe_priority, earliest posted_at, id) and point the rest at it via duplicate_of (docs/ARCHITECTURE.md §13.3.3, §13.6.4). Idempotent. service_role only.';

-- ---------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------

-- Trigger functions: not callable by anyone but their owner. Firing a
-- trigger doesn't check EXECUTE (it is only checked when the trigger is
-- created), so revoking from service_role too doesn't affect its writes.
revoke execute on function public.job_descriptions_set_content_hash() from public, anon, authenticated, service_role;
revoke execute on function public.job_descriptions_guard() from public, anon, authenticated, service_role;

revoke execute on function private.validate_job_listing_fields(text, text, text, text, text, text) from public, anon, authenticated;

-- User RPCs: authenticated only (they resolve the caller from auth.uid()).
revoke execute on function public.create_job_listing(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_job_listing(text, text, text, text, text, text, text) to authenticated;

revoke execute on function public.update_job_listing(uuid, jsonb) from public, anon;
grant execute on function public.update_job_listing(uuid, jsonb) to authenticated;

revoke execute on function public.delete_job_listing(uuid) from public, anon;
grant execute on function public.delete_job_listing(uuid) to authenticated;

-- Search: SECURITY INVOKER, called through the session client (RLS applies).
revoke execute on function public.search_job_descriptions(text, text, text, integer, integer) from public, anon;
grant execute on function public.search_job_descriptions(text, text, text, integer, integer) to authenticated;

revoke execute on function public.enqueue_source_syncs() from public, anon, authenticated;
grant execute on function public.enqueue_source_syncs() to service_role;

revoke execute on function public.expire_stale_job_descriptions() from public, anon, authenticated;
grant execute on function public.expire_stale_job_descriptions() to service_role;

revoke execute on function public.resolve_job_duplicates(text[]) from public, anon, authenticated;
grant execute on function public.resolve_job_duplicates(text[]) to service_role;

-- ---------------------------------------------------------------------
-- Cron jobs
-- ---------------------------------------------------------------------
-- Unschedule-then-schedule, as in 0008.

do $$
declare
  v_jobid bigint;
begin
  for v_jobid in
    select j.jobid
    from cron.job j
    where j.jobname in ('kalify-expire-jobs', 'kalify-ingest')
  loop
    perform cron.unschedule(v_jobid);
  end loop;
end;
$$;

-- Daily expiry sweep, 30 minutes before ingest.
select cron.schedule(
  'kalify-expire-jobs',
  '30 12 * * *',
  $cmd$select public.expire_stale_job_descriptions();$cmd$
);

-- Daily ingest: enqueues ingest.sync_source tasks; the every-minute worker
-- tick (kalify-worker-tick, 0008) runs them.
select cron.schedule(
  'kalify-ingest',
  '0 13 * * *',
  $cmd$select public.enqueue_source_syncs();$cmd$
);
