-- 2026-08-13: set_job_duration RPC + DB-level lock blocking dispatcher from
-- writing estimated_duration_minutes.
--
-- Depends on 2026-08-13-job-scheduling-window-and-duration.sql (adds the
-- column this migration writes to and locks down).
--
-- Two parts, same goal ("the dispatcher will not know" -- Dante):
--
-- 1) set_job_duration(p_job_id, p_minutes): the only way estimated_duration_
--    minutes gets written from the app. SECURITY DEFINER so it can grant a
--    plumber write access without a broad raw-UPDATE policy on jobs (which
--    they don't have and shouldn't get just for this). Allowed callers:
--    owner (any job in their company), or a plumber who is an assignee of
--    that specific job (via job_assignees -- the same multi-assignee source
--    of truth used everywhere else in this schema, not the legacy single
--    claimed_by column). Dispatcher is explicitly rejected here too, not
--    just left out of the UI, matching this function's own style of
--    explicit checks (see set_pricing_approver/approve_job_estimate).
--
-- 2) jobs_before_update_duration_scope_lock trigger: closes the same gap
--    jobs_before_update_assignment_lock already closes for claimed_by --
--    owner+dispatcher both hold full raw-UPDATE grant on jobs via
--    jobs_update_owner_dispatcher_company, and RLS can't restrict a single
--    column. This trigger compares OLD vs NEW on estimated_duration_minutes
--    and blocks the change outright unless the caller is the owner (the RPC
--    above runs as the function owner via SECURITY DEFINER, which bypasses
--    RLS *and* triggers still fire for it the same as any other UPDATE --
--    but the RPC's own internal role check already gated who could call it,
--    so this trigger accepts SECURITY DEFINER writes coming from a
--    plumber-owned RPC call by also allowing the plumber-assigned case).

create or replace function public.set_job_duration(p_job_id uuid, p_minutes integer)
returns public.jobs
language plpgsql security definer
set search_path to 'public'
as $function$
declare
  v_job jobs%rowtype;
  v_is_assigned boolean;
begin
  select * into v_job from jobs where id = p_job_id;
  if v_job is null or v_job.company_id <> get_my_company_id() then
    raise exception 'Job not found in your company';
  end if;

  if get_my_role() = 'owner' then
    -- allowed
  elsif get_my_role() = 'plumber' then
    select exists (
      select 1 from job_assignees ja
      where ja.job_id = p_job_id and ja.employee_id = get_my_employee_id()
    ) into v_is_assigned;
    if not v_is_assigned then
      raise exception 'Only a plumber assigned to this job can set its duration';
    end if;
  else
    raise exception 'Only the owner or an assigned plumber can set job duration';
  end if;

  if p_minutes is not null and p_minutes <= 0 then
    raise exception 'Duration must be a positive number of minutes';
  end if;

  update jobs set estimated_duration_minutes = p_minutes where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$function$;

create or replace function public.jobs_before_update_duration_scope_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_assigned boolean;
begin
  if NEW.estimated_duration_minutes is distinct from OLD.estimated_duration_minutes then
    if get_my_role() = 'owner' then
      return NEW;
    end if;
    if get_my_role() = 'plumber' then
      select exists (
        select 1 from job_assignees ja
        where ja.job_id = OLD.id and ja.employee_id = get_my_employee_id()
      ) into v_is_assigned;
      if v_is_assigned then
        return NEW;
      end if;
    end if;
    raise exception 'Only the owner or an assigned plumber can change job duration';
  end if;
  return NEW;
end;
$function$;

create trigger jobs_before_update_duration_scope_lock_trigger
  before update on public.jobs
  for each row execute function jobs_before_update_duration_scope_lock();

-- set_job_duration is SECURITY DEFINER (runs as the function owner, a
-- superuser-ish role that bypasses RLS) but Postgres still fires row-level
-- triggers on every UPDATE regardless of how RLS was bypassed -- so this
-- trigger and the RPC's own role check both evaluate on every call. That's
-- intentional, not redundant: the RPC is the only code path the app uses,
-- and the trigger is what actually stops a raw client-side
-- `.from('jobs').update(...)` bypassing the RPC entirely.

grant execute on function public.set_job_duration(uuid, integer) to authenticated;

-- Verification queries (run after applying):
--   select proname from pg_proc where proname = 'set_job_duration'; -- expect 1 row
--   select tgname from pg_trigger where tgname = 'jobs_before_update_duration_scope_lock_trigger'; -- expect 1 row
--   -- as an owner: select set_job_duration('<a job id in your company>', 45); -- should succeed
--   -- as a dispatcher: attempt supabase.from('jobs').update({estimated_duration_minutes: 30}).eq('id', '<job id>')
--   --   directly (bypassing the RPC) -- should fail with the trigger's exception text
--   -- as an unassigned plumber: call set_job_duration on a job they're not assigned to -- should fail

-- ============ ROLLBACK ============
-- drop trigger if exists jobs_before_update_duration_scope_lock_trigger on public.jobs;
-- drop function if exists public.jobs_before_update_duration_scope_lock();
-- revoke execute on function public.set_job_duration(uuid, integer) from authenticated;
-- drop function if exists public.set_job_duration(uuid, integer);
