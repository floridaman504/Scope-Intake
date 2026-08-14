-- Rollback for 2026-08-14-grant-job-assignees-table.sql

revoke select, insert, delete on public.job_assignees from authenticated;
