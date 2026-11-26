-- Kalify — job board filters: sort, location, field (docs/ARCHITECTURE.md §7.8.5).
--
-- * job_category / location_states / is_remote are derived in TypeScript at
--   write time (lib/jobs/facets.ts). job_category null = "facets not computed
--   yet"; the daily sync cron backfills (lib/jobs/backfillFacets.ts).
-- * listed_at = coalesce(posted_at, created_at), stored, so the "Most recent"
--   order and the keyset cursor use a real column.
-- * search_job_descriptions is dropped and re-created with the filter/sort
--   params. Every new param has a default, so the old 4-argument named call
--   (search_query, level_filter, limit_count, offset_count) still resolves.
--   Relevance order, the deleted_at filter, security invoker and the empty
--   search_path are unchanged from 0006; the tiebreak moves from created_at to
--   listed_at.
-- * job_description_facets(): global counts over active rows, granted to
--   authenticated (and service_role) only.
--
-- Deploy order: apply this BEFORE the code that reads the new columns. Code
-- from before this migration keeps working after it (new columns are nullable
-- or defaulted; old RPC call still resolves). The begin/commit keeps the drop
-- and re-create of the search function atomic.
--
-- Depends only on 0004–0006 (independent of the parked 0009; §13.3.0).
-- Forward-only. Never edit after it has been applied; add a new migration.

begin;

alter table public.job_descriptions
  add column job_category    text null,
  add column location_states text[] not null default '{}',
  add column is_remote       boolean not null default false,
  add column listed_at       timestamptz generated always as (coalesce(posted_at, created_at)) stored;

-- A check of `job_category in (...)` passes for null, which is intended.
alter table public.job_descriptions add constraint job_descriptions_job_category_check
  check (job_category in ('software','data','it-security','hardware','product','design','science',
    'finance','business-ops','sales-marketing','people-hr','legal','healthcare','trades','other'));
alter table public.job_descriptions add constraint job_descriptions_location_states_check
  check (location_states <@ array['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID',
    'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM',
    'NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']::text[]);

create index job_descriptions_listed_at_idx
  on public.job_descriptions (listed_at desc, id desc) where deleted_at is null;
create index job_descriptions_job_category_idx
  on public.job_descriptions (job_category) where deleted_at is null;
create index job_descriptions_location_states_idx
  on public.job_descriptions using gin (location_states);

drop function public.search_job_descriptions(text, text, int, int);
create function public.search_job_descriptions(
  search_query    text,
  level_filter    text    default null,
  category_filter text    default null,
  state_filter    text    default null,
  remote_only     boolean default false,
  sort_mode       text    default 'relevance',   -- 'relevance' | 'recent'
  limit_count     int     default 20,
  offset_count    int     default 0
)
returns setof public.job_descriptions
language sql stable security invoker set search_path = ''
as $$
  select *
  from public.job_descriptions
  where search_vector @@ websearch_to_tsquery('english', search_query)
    and deleted_at is null
    and (level_filter    is null or level = level_filter)
    and (category_filter is null or job_category = category_filter)
    and (state_filter    is null or location_states @> array[state_filter])
    and (not remote_only or is_remote)
  order by
    case when sort_mode = 'recent' then listed_at end desc nulls last,
    ts_rank(search_vector, websearch_to_tsquery('english', search_query)) desc,
    listed_at desc,
    id desc
  limit limit_count
  offset offset_count;
$$;

comment on function public.search_job_descriptions(text, text, text, text, boolean, text, int, int) is
  'Full-text search over job_descriptions (GET /api/job-descriptions?q=), per docs/ARCHITECTURE.md §9/§10/§7.8. Excludes soft-deleted rows. Optional level/category/state/remote filters; sort_mode ''relevance'' (ts_rank, default) or ''recent'' (listed_at). Ties break by listed_at desc, id desc for deterministic offset pagination (§9.2).';

create function public.job_description_facets()
returns table (facet text, value text, listing_count bigint)
language sql stable security invoker set search_path = ''
as $$
  select 'category', job_category, count(*) from public.job_descriptions
    where deleted_at is null and job_category is not null group by job_category
  union all
  select 'state', s, count(*) from public.job_descriptions, unnest(location_states) as s
    where deleted_at is null group by s
  union all
  select 'remote', 'true', count(*) from public.job_descriptions
    where deleted_at is null and is_remote;
$$;
revoke execute on function public.job_description_facets() from public, anon;
grant execute on function public.job_description_facets() to authenticated, service_role;

comment on function public.job_description_facets() is
  'Global board-filter counts over active job_descriptions (GET /api/job-descriptions/facets, docs/ARCHITECTURE.md §7.8.6). Does not depend on other filters. security invoker: RLS applies as for a plain select.';

comment on column public.job_descriptions.job_category is '§7.8.3 field slug; null = facets not computed yet (backfilled by the sync cron). Set only by server code via lib/jobs/facets.ts.';
comment on column public.job_descriptions.location_states is '§7.8.2 USPS codes parsed from location; set with job_category.';
comment on column public.job_descriptions.is_remote is '§7.8.2 explicit remote signal parsed from location / source workplace type.';
comment on column public.job_descriptions.listed_at is '§7.8.1 coalesce(posted_at, created_at); "Most recent" order and keyset cursor.';

commit;
