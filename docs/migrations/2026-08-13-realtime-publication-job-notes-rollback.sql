-- Rollback for 2026-08-13-realtime-publication-job-notes.sql
--
-- Only removes job_notes -- jobs and job_assignees were already live in
-- production before this migration (added out-of-band, this migration
-- just documented them), so rolling back should not silently break the
-- existing dashboard-jobs-badge / jobs-queue realtime subscriptions.

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_notes'
  ) then
    alter publication supabase_realtime drop table public.job_notes;
  end if;
end $$;
