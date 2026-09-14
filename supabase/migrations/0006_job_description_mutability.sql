-- Adds edit/soft-delete for user-submitted job descriptions, per
-- docs/ARCHITECTURE.md §10 ("Job description mutability"). Revisits the
-- immutability stance deferred in §4/§5: the real risk was never "editing
-- invalidates match rationale" (matches store a snapshot, not a live
-- reference — see §10's "Why"), it's that `matches.job_description_id` is
-- `on delete cascade`, so a **hard** delete would silently destroy other
-- users' match history. Soft delete (`deleted_at`) avoids that risk entirely
-- while still letting a submitter hide a posting they submitted by mistake.

alter table public.job_descriptions add column deleted_at timestamptz;

comment on column public.job_descriptions.deleted_at is
  'Null = visible/active; non-null = soft-deleted (hidden) by its submitter via DELETE /api/job-descriptions/:id. Excluded from listing/search (GET /api/job-descriptions), but GET /api/job-descriptions/:id and existing matches keep resolving it regardless, per docs/ARCHITECTURE.md §10.';

-- First update/delete policy of any kind on `job_descriptions` (§1 had
-- none). `source = 'user'` is checked in both `using` and `with check`
-- even though `submitted_by = auth.uid()` alone already excludes every
-- `source='themuse'` row (their `submitted_by` is always null) — this is
-- defense-in-depth, not dead weight: it also stops a caller's own row from
-- being mutated into `source='themuse'`/given a fake `external_id` by a
-- direct Postgres call that bypasses the API's validation layer, per this
-- document's existing "checked twice" philosophy (§2's intro). No `delete`
-- policy is added at all — hard delete has no path in or out of RLS,
-- matching §10.1's decision that hard delete is never exposed.
create policy "job_descriptions_update_own" on job_descriptions
  for update to authenticated
  using (submitted_by = auth.uid() and source = 'user')
  with check (submitted_by = auth.uid() and source = 'user');

-- Same function name/signature as §9.1 — `create or replace`, not a new
-- function — just adding the `deleted_at is null` predicate so a
-- soft-deleted posting stops appearing in search results.
create or replace function public.search_job_descriptions(
  search_query text,
  level_filter text default null,
  limit_count int default 20,
  offset_count int default 0
)
returns setof public.job_descriptions
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from public.job_descriptions
  where search_vector @@ websearch_to_tsquery('english', search_query)
    and deleted_at is null
    and (level_filter is null or level = level_filter)
  order by
    ts_rank(search_vector, websearch_to_tsquery('english', search_query)) desc,
    created_at desc,
    id desc
  limit limit_count
  offset offset_count;
$$;

comment on function public.search_job_descriptions is
  'Ranked full-text search over job_descriptions (GET /api/job-descriptions?q=), per docs/ARCHITECTURE.md §9/§10. Excludes soft-deleted rows (deleted_at is null). Tiebreaks equal ts_rank by created_at desc, id desc purely for deterministic ordering — not used for cursor comparisons (search-mode pagination is offset-based, see §9.2).';

-- The plain keyset listing (`listJobDescriptions` in
-- lib/supabase/queries/jobDescriptions.ts) gains the equivalent
-- `.is("deleted_at", null)` filter in application code rather than here —
-- it's a plain `.select()`, not a SQL function, so there's no migration-side
-- equivalent to change.
