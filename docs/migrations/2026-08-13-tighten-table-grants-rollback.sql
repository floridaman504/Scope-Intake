-- Rollback for 2026-08-13-tighten-table-grants.sql
--
-- Restores Supabase's original default: all seven privileges to both
-- anon and authenticated on every table in the public schema, matching
-- the state documented in docs/schema/production-schema-2026-08-09.sql
-- before this migration. RLS remains the real access-control layer either
-- way -- this only widens the belt-and-suspenders backstop back out.

grant delete, insert, references, select, trigger, truncate, update
  on all tables in schema public
  to anon, authenticated;
