-- Rollback for 2026-08-13-job-notes-plumber-access.sql

drop policy if exists job_notes_insert_assigned_plumber on public.job_notes;
drop policy if exists job_notes_select_assigned_plumber on public.job_notes;
