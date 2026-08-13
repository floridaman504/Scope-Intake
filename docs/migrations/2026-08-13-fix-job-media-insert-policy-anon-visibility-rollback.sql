-- Rollback for 2026-08-13-fix-job-media-insert-policy-anon-visibility.sql
--
-- Reverts to the original (broken-for-anon, anon-only) policy shape from
-- docs/migrations/2026-08-12-job-media-storage-bucket.sql. Does NOT restore
-- the two dead/broken pre-existing policies (anon_can_upload_to_valid_job,
-- employees_select_own_company_media) or job_exists() that this migration
-- removed -- they were confirmed non-functional (compared the wrong path
-- segment against the wrong column) and safe to leave gone regardless of
-- whether the rest of this migration is rolled back.
--
-- Only roll this back if you're also reverting to a client that no longer
-- needs anon/authenticated uploads to work -- otherwise this reintroduces
-- the RLS failure this migration fixed.

drop policy if exists job_media_insert_matches_real_job on storage.objects;

create policy job_media_insert_matches_real_job
on storage.objects for insert to anon
with check (
  bucket_id = 'job-media'
  and exists (
    select 1 from jobs j
    where j.id::text = (storage.foldername(name))[2]
      and j.company_id::text = (storage.foldername(name))[1]
  )
);

drop function if exists public.job_media_path_is_valid(text, text);
