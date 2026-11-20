-- Kalify v2 — worker schedule (milestone M1.2).
--
-- Implements docs/ARCHITECTURE.md §13.3.2:
--   * pg_cron + pg_net
--   * private.invoke_worker_tick(): POSTs to the worker tick route using
--     Vault secrets, failing closed (raise warning + skip) when they are
--     missing or unusable
--   * cron jobs (UTC):
--       kalify-worker-tick    * * * * *    private.invoke_worker_tick()
--       kalify-purge-tasks    15 4 * * *   public.purge_finished_tasks()
--       kalify-stale-leases   5 * * * *    public.dead_letter_stale_tasks()
--       kalify-cron-history   30 4 * * *   prune cron.job_run_details > 7 days
--
-- Vault secrets are created MANUALLY per environment, never committed
-- (§13.3.2, §13.19 Q9):
--   select vault.create_secret('https://<prod-domain>/api/worker/tick', 'kalify_worker_url');
--   select vault.create_secret('<same value as Vercel WORKER_SECRET>', 'kalify_worker_secret');
-- This migration applies cleanly before they exist; until then every tick
-- logs a warning and does nothing.
--
-- Forward-only. Never edit after it has been applied; add a new migration.

-- ---------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------

-- Supabase installs pg_cron into pg_catalog (its objects live in the `cron`
-- schema) and pg_net into `extensions` (its objects live in the `net`
-- schema), per Supabase's install docs.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Per Supabase's pg_cron install docs, so the postgres role (which owns the
-- jobs below and runs them) can manage cron.job_run_details.
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- ---------------------------------------------------------------------
-- private.invoke_worker_tick
-- ---------------------------------------------------------------------
-- Reads kalify_worker_url / kalify_worker_secret from Vault and queues an
-- async POST via pg_net (sent after commit; pg_net never blocks cron).
-- Fails closed: if either secret is missing/blank, or the URL isn't https
-- (http is tolerated only for local hosts, for local stacks), it raises a
-- WARNING and skips, so nothing is ever sent unauthenticated or in clear
-- text to a remote host. Never logs the secret.
-- Returns the pg_net request id, or NULL when skipped.
create function private.invoke_worker_tick()
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select s.decrypted_secret into v_url
  from vault.decrypted_secrets s
  where s.name = 'kalify_worker_url'
  limit 1;

  select s.decrypted_secret into v_secret
  from vault.decrypted_secrets s
  where s.name = 'kalify_worker_secret'
  limit 1;

  v_url := nullif(btrim(coalesce(v_url, '')), '');
  v_secret := nullif(btrim(coalesce(v_secret, '')), '');

  if v_url is null or v_secret is null then
    raise warning 'kalify-worker-tick: Vault secret kalify_worker_url and/or kalify_worker_secret is not set; skipping tick.';
    return null;
  end if;

  if not (
    v_url ~* '^https://[^/\s]+'
    or v_url ~* '^http://(localhost|127\.0\.0\.1|host\.docker\.internal)(:[0-9]+)?(/|$)'
  ) then
    raise warning 'kalify-worker-tick: kalify_worker_url must be an https:// URL; skipping tick.';
    return null;
  end if;

  return net.http_post(
    url := v_url,
    body := '{"trigger":"cron"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 5000
  );
end;
$$;

comment on function private.invoke_worker_tick is
  'pg_cron target for kalify-worker-tick (docs/ARCHITECTURE.md §13.3.2): POST {"trigger":"cron"} to Vault kalify_worker_url with Bearer kalify_worker_secret via pg_net. Fails closed (warning + skip) when the secrets are missing.';

revoke execute on function private.invoke_worker_tick() from public, anon, authenticated;
-- Deliberately no grant to service_role: the only caller is pg_cron, which
-- runs the job as its owner (postgres, the function's owner).

-- ---------------------------------------------------------------------
-- Cron jobs
-- ---------------------------------------------------------------------
-- Unschedule-then-schedule keeps this re-runnable on any pg_cron version
-- (whether or not cron.schedule upserts by name).

do $$
declare
  v_jobid bigint;
begin
  for v_jobid in
    select j.jobid
    from cron.job j
    where j.jobname in ('kalify-worker-tick', 'kalify-purge-tasks', 'kalify-stale-leases', 'kalify-cron-history')
  loop
    perform cron.unschedule(v_jobid);
  end loop;
end;
$$;

select cron.schedule(
  'kalify-worker-tick',
  '* * * * *',
  $cmd$select private.invoke_worker_tick();$cmd$
);

select cron.schedule(
  'kalify-purge-tasks',
  '15 4 * * *',
  $cmd$select public.purge_finished_tasks();$cmd$
);

-- Hourly stale-lease sweep (§13.3.1): frees tasks of unregistered kinds
-- stuck in `running` after their worker died.
select cron.schedule(
  'kalify-stale-leases',
  '5 * * * *',
  $cmd$select public.dead_letter_stale_tasks();$cmd$
);

select cron.schedule(
  'kalify-cron-history',
  '30 4 * * *',
  $cmd$delete from cron.job_run_details where end_time < now() - interval '7 days';$cmd$
);
