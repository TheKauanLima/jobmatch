-- Adds support for machine-ingested job listings alongside user-submitted
-- ones, per docs/ARCHITECTURE.md §7 ("External job ingestion").
--
-- Context: v1 shipped with `job_descriptions` populated only by users pasting
-- postings in manually, which leaves the shared board empty for every new
-- user until enough people contribute. This migration adds the columns
-- needed to ingest real listings from an external source (The Muse public
-- Jobs API) without changing the table's existing shape/semantics for
-- user-submitted rows — every new column is nullable (or has a
-- backward-compatible default) so `0001_init.sql`'s rows are unaffected.

alter table public.job_descriptions
  add column source text not null default 'user'
    check (source in ('user', 'themuse')),
  add column external_id text,
  add column level text,
  add column location text,
  add column posted_at timestamptz;

comment on column public.job_descriptions.source is
  'Where this row came from: ''user'' (submitted via POST /api/job-descriptions) or ''themuse'' (ingested from The Muse public Jobs API — see lib/jobs/).';
comment on column public.job_descriptions.external_id is
  'The source''s own id for this listing (e.g. The Muse''s numeric job id, as a string). Null for source=''user''. Used with `source` for upsert dedup so re-running ingestion updates existing rows instead of duplicating them.';
comment on column public.job_descriptions.level is
  'Seniority/experience level as reported by the source (e.g. ''Internship'', ''Entry Level''). Null for source=''user'' and for external rows the source didn''t tag. Free text, not an enum — external sources control this vocabulary, not us.';
comment on column public.job_descriptions.location is
  'Free-text location(s) as reported by the source (e.g. ''New York, NY'' or ''Remote''). Null for source=''user'' (no location field on manual submission in v1) and for external rows the source didn''t tag.';
comment on column public.job_descriptions.posted_at is
  'When the source says the listing was originally posted (distinct from `created_at`, which is when JobMatch ingested/created the row). Null for source=''user''.';

-- Dedup key for ingestion upserts: re-running a sync for the same external
-- listing must update the existing row, not insert a duplicate. A plain
-- unique constraint is correct here even though `external_id` is null for
-- every `source = 'user'` row — Postgres treats each NULL as distinct from
-- every other NULL in a unique constraint, so any number of ('user', null)
-- rows can coexist; the constraint only ever actually deduplicates rows that
-- share a non-null (source, external_id) pair.
alter table public.job_descriptions
  add constraint job_descriptions_source_external_id_key
  unique (source, external_id);

-- Supports `GET /api/job-descriptions?level=...` filtering without a full
-- table scan once the board has a meaningful number of external listings.
create index job_descriptions_level_idx
  on public.job_descriptions (level)
  where level is not null;

-- No RLS policy change needed: ingestion runs from a trusted server-side
-- script/route using the service-role client (lib/supabase/admin.ts), which
-- bypasses RLS entirely by design (see docs/ARCHITECTURE.md §3's note on
-- admin.ts) rather than going through the existing
-- `job_descriptions_insert_own` policy (which requires
-- `submitted_by = auth.uid()` and would reject a row with `submitted_by
-- null` from an unauthenticated cron context). The existing
-- `job_descriptions_select_all_authenticated` policy already covers reads of
-- these new rows for any authenticated user, same as user-submitted ones.
