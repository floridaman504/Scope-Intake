-- Rollback for 2026-08-13-set-job-duration-rpc-and-lock.sql

drop trigger if exists jobs_before_update_duration_scope_lock_trigger on public.jobs;
drop function if exists public.jobs_before_update_duration_scope_lock();

revoke execute on function public.set_job_duration(uuid, integer) from authenticated;
drop function if exists public.set_job_duration(uuid, integer);
