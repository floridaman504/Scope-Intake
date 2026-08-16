-- Rollback for 2026-08-16-audit-trail.sql
--
-- Drops the triggers first (so nothing can fire mid-rollback), then the
-- trigger/RPC functions, then the table itself (which also drops its index
-- and RLS policy automatically). Purely additive migration, so this is a
-- clean, complete inverse -- no existing data or behavior was changed by
-- the forward migration, only new logging was added.

drop trigger if exists employees_audit_log_after_insert on public.employees;
drop trigger if exists employees_audit_log_after_update on public.employees;
drop function if exists public.employees_audit_log_trigger();

drop trigger if exists jobs_audit_log_after_delete_trigger on public.jobs;
drop function if exists public.jobs_audit_log_after_delete();

revoke execute on function public.log_password_reset() from authenticated;
drop function if exists public.log_password_reset();

revoke select on public.audit_log from authenticated;
drop table if exists public.audit_log;
