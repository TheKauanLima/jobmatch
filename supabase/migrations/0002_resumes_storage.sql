-- Private Storage bucket for resume files, plus RLS policies that key
-- object access off the first path segment matching the caller's own
-- auth.uid(). Path convention (owned by lib/storage/resumeFiles.ts):
--   {user_id}/{id}.{ext}
--
-- Source of truth: docs/ARCHITECTURE.md §1 ("resumes" table section) and
-- §3 (lib/storage/resumeFiles.ts).

insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', false)
on conflict (id) do nothing;

-- storage.objects already has RLS enabled by default in Supabase; these
-- policies scope access to objects whose top-level "folder" equals the
-- caller's own user id, e.g. `11111111-.../abc.pdf` is only accessible to
-- auth.uid() = '11111111-...'.

create policy "resumes_bucket_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "resumes_bucket_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "resumes_bucket_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "resumes_bucket_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- No policy for `anon` — logged-out visitors get no access to any resume
-- object, matching the "private to owner" requirement in §1.
