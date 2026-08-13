-- Rollback for 2026-08-12-job-media-storage-bucket.sql
--
-- WARNING: dropping the bucket deletes every object stored inside it. If
-- customer media has already been uploaded by the time you need to roll
-- this back, export/back up the bucket's objects first -- this is
-- destructive, not just a policy revert.

drop policy if exists job_media_select_own_company on storage.objects;
drop policy if exists job_media_insert_matches_real_job on storage.objects;

delete from storage.buckets where id = 'job-media';
