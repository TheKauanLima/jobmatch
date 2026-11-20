-- Kalify — allow Greenhouse and Lever as job_descriptions sources
-- (docs/ARCHITECTURE.md §7.7.7). The Muse's API now answers every automated
-- request with a Cloudflare 403, so the daily sync moved to the public
-- Greenhouse and Lever job-board APIs (§7.7).
--
-- * 'themuse' stays valid: the existing rows remain and old matches still
--   resolve to them (they are soft-deleted separately, with the user's OK,
--   after the first successful production run — §7.7.8).
-- * The drop is deliberately written WITHOUT `if exists`: the constraint is
--   the auto-generated name of 0004's inline column check, and a wrong name
--   must fail loudly instead of leaving the old constraint in place.
-- * No RLS change: job_descriptions_update_own already requires
--   source = 'user', so greenhouse/lever rows are read-only for users.
-- * Numbering: §13.3.0 (0009 is parked on wip/m1.5-ingestion).
--
-- Forward-only. Never edit after it has been applied; add a new migration.

alter table public.job_descriptions drop constraint job_descriptions_source_check;

alter table public.job_descriptions add constraint job_descriptions_source_check
  check (source in ('user', 'themuse', 'greenhouse', 'lever'));

comment on column public.job_descriptions.source is
  'Where this row came from: ''user'' (submitted via POST /api/job-descriptions), ''themuse'' (legacy, ingested from The Muse public Jobs API; no longer synced), ''greenhouse'' or ''lever'' (ingested daily from a company''s public job board — see lib/jobs/sync.ts and lib/jobs/sources/).';
