-- 2026-08-13: Add job_notes to the supabase_realtime publication, and
-- document jobs/job_assignees' existing (previously undocumented)
-- membership.
--
-- Context: grepped every migration file in this repo for
-- "alter publication"/"supabase_realtime" before writing this -- zero
-- hits, despite Dashboard.jsx (`dashboard-jobs-badge`) and JobsQueue.jsx
-- (`jobs-queue`) both already successfully subscribing to postgres_changes
-- on `jobs` and `job_assignees` in production today. That only works if
-- those two tables are already in the supabase_realtime publication --
-- which means someone added them by hand via the Supabase dashboard
-- (Database > Replication), with no migration, no PR, no audit trail.
-- Exactly the kind of out-of-band prod change the new CI migration
-- pipeline (docs/migrations/2026-08-13-schema-migrations-tracking-table.sql
-- and friends) exists to close for DDL -- this closes the same gap for
-- publication membership, and gets job_notes added the RIGHT way from the
-- start instead of by hand.
--
-- Written idempotently (checks pg_publication_tables first) rather than
-- relying on Postgres 15's `ADD TABLE IF NOT EXISTS` syntax, so this is
-- safe to run regardless of the exact server version and safe to re-run.
--
-- Note: adding a table to supabase_realtime does NOT bypass RLS --
-- Supabase Realtime still evaluates each subscriber's row-level security
-- policies per change event, so a plumber's job_notes subscription will
-- only receive events for rows their own RLS policies (added in
-- 2026-08-13-job-notes-plumber-access.sql) let them see.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jobs'
  ) then
    alter publication supabase_realtime add table public.jobs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_assignees'
  ) then
    alter publication supabase_realtime add table public.job_assignees;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_notes'
  ) then
    alter publication supabase_realtime add table public.job_notes;
  end if;
end $$;

-- Verification queries (run after applying):
--   select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by tablename;
--   -- expect jobs, job_assignees, job_notes all present (plus anything else already there, e.g. user_sessions)
