-- Adds server-side full-text search over `job_descriptions`, per
-- docs/ARCHITECTURE.md §9 ("Server-side job search"). No change to any
-- existing column, row, or the four other tables.

-- `search_vector` is a stored generated column (not a plain expression
-- index) so it's a real, `select *`-visible column that
-- `search_job_descriptions` below can reference directly. Weighted
-- title (A) > company (B) > description (C) > location (D) — Postgres's
-- default rank weight array is {D,C,B,A} = {0.1, 0.2, 0.4, 1.0}, so this
-- ordering matches the ask, with location deliberately last since it's the
-- least distinguishing of the four fields (many listings share a city, or
-- 'Remote').
alter table public.job_descriptions
  add column search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(company, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(location, '')), 'D')
  ) stored;

comment on column public.job_descriptions.search_vector is
  'Generated tsvector for full-text search (GET /api/job-descriptions?q=), derived from title/company/description/location. Maintained by Postgres; never written directly by application code. Internal-only — omitted from the client-facing JobDescription type in types/domain.ts.';

create index job_descriptions_search_vector_idx
  on public.job_descriptions using gin (search_vector);

-- Ranking needs a Postgres function, not a plain `.select()`: `ts_rank` is
-- computed at query time (not stored), and supabase-js's fluent query
-- builder only accepts real column names for `.order()` — it has no way to
-- order by a computed expression. This function does the match + rank +
-- paginate in one round trip. `set search_path = ''` (with the table
-- reference fully qualified as `public.job_descriptions`) follows the same
-- hardening `0003_fix_function_search_path.sql` already applied to
-- `set_updated_at()`. `security invoker` (the default, stated explicitly for
-- auditability) means the function runs as whichever role calls it — when
-- called from a route handler's normal RLS-scoped session client, the
-- `job_descriptions_select_all_authenticated` policy still applies exactly
-- as it does for a plain `select *`. No RLS bypass, no new policy needed.
create function public.search_job_descriptions(
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
    and (level_filter is null or level = level_filter)
  order by
    ts_rank(search_vector, websearch_to_tsquery('english', search_query)) desc,
    created_at desc,
    id desc
  limit limit_count
  offset offset_count;
$$;

comment on function public.search_job_descriptions is
  'Ranked full-text search over job_descriptions (GET /api/job-descriptions?q=), per docs/ARCHITECTURE.md §9. Tiebreaks equal ts_rank by created_at desc, id desc purely for deterministic ordering — not used for cursor comparisons (search-mode pagination is offset-based, see §9.2).';
