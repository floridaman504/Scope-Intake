-- Fixes two problems discovered while debugging "/login isn't loading":
--
-- 1. LOGIN-BLOCKING BUG: "Owners can view all employees" (a policy left
--    over from before the multi-tenant migration) queries `employees`
--    FROM WITHIN a policy ON `employees`, with no security-definer
--    bypass. Postgres detected this as infinite recursion and every
--    authenticated select against employees failed with:
--      infinite recursion detected in policy for relation "employees"
--    This is why the dashboard showed "You don't have access to this
--    page" for every account, including freshly-fixed ones.
--
-- 2. CROSS-TENANT SECURITY GAPS: the original multi-tenant migration's
--    `drop policy if exists` calls used different policy names than what
--    was actually live (the real names were things like "Owners can
--    view all employees", not "employees_select_own"), so they silently
--    no-op'd and left several pre-multi-tenant policies active
--    alongside the new company-scoped ones. Since RLS policies for the
--    same command are OR'd together, the old ones were still fully in
--    effect:
--      - "Owners and dispatchers can view all jobs" / "...update jobs" /
--        "Only owners can delete jobs" checked role but never company_id
--        -- any owner/dispatcher from ANY company could view, edit, or
--        delete ANY OTHER company's jobs.
--      - "Public can submit jobs" had `with_check: true` with no
--        resolution logic at all -- anyone could insert a job with an
--        arbitrary company_id directly via the REST API, bypassing
--        submit_public_job()'s server-side subdomain resolution
--        entirely (the exact spoofing vector that function was written
--        to close).
--      - "New users can create their own employee record" let any
--        authenticated user self-insert an employees row with ANY role
--        and ANY company_id, bypassing redeem_invite_code() entirely.
--
-- This has already been applied directly against production
-- (2026-08-03) to restore login. This file checks the fix into source
-- control and makes it reproducible on any other environment.

-- Helper to resolve the caller's own role without a raw subquery on
-- employees inside a policy (mirrors get_my_company_id()'s pattern).
create or replace function get_my_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from employees where user_id = auth.uid();
$$;
grant execute on function get_my_role() to authenticated;

-- employees: drop the leftover pre-multi-tenant policies.
drop policy if exists "Owners can view all employees" on employees;
drop policy if exists "Employees can view their own record" on employees;
drop policy if exists "New users can create their own employee record" on employees;

-- jobs: drop the non-company-scoped legacy policies and the wide-open
-- public insert policy, then replace update/delete with company-scoped
-- versions so owners/dispatchers keep the ability to edit and delete
-- jobs -- just only within their own company.
drop policy if exists "Owners and dispatchers can view all jobs" on jobs;
drop policy if exists "Owners and dispatchers can update jobs" on jobs;
drop policy if exists "Only owners can delete jobs" on jobs;
drop policy if exists "Public can submit jobs" on jobs;

create policy "jobs_update_owner_dispatcher_company"
on jobs for update
to authenticated
using (company_id = get_my_company_id() and get_my_role() in ('owner', 'dispatcher'));

create policy "jobs_delete_owner_company"
on jobs for delete
to authenticated
using (company_id = get_my_company_id() and get_my_role() = 'owner');
