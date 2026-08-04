-- =========================================================
-- Scopwell Multi-Tenant Migration
-- Run once in Supabase SQL Editor -> New query.
--
-- What this does:
--   1. Creates a `companies` table (one row per plumbing/trade company
--      using Scopwell). `subdomain` is what resolves e.g.
--      acme-plumbing.scopwell.com -> that company's data.
--   2. Adds `company_id` to employees, invite_codes, and jobs.
--   3. Backfills all EXISTING rows (currently demo/test data) into a
--      single "Demo Company" row so nothing breaks.
--   4. Makes company_id required going forward.
--   5. Rewrites every RLS policy so one company can never see another
--      company's employees or jobs.
--   6. Replaces the raw public `jobs` insert with a security-definer
--      function (submit_public_job) that resolves the company from the
--      subdomain SERVER-SIDE -- the browser can never spoof another
--      company's id by tampering with the request.
--   7. Updates redeem_invite_code() to assign the new employee to the
--      same company as the invite code that was used.
-- =========================================================

-- ---------------------------------------------------------
-- 1. companies table
-- ---------------------------------------------------------
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subdomain text not null unique,
  custom_domain text unique,       -- for the future white-label tier (task #15)
  plan text not null default 'standard',
  created_at timestamptz not null default now()
);

alter table companies enable row level security;
-- No select/insert/update policies are created here on purpose.
-- Direct table access is default-deny for everyone, including logged-in
-- employees. The only sanctioned way to read company info is the
-- get_company_by_subdomain() function below, which only ever returns
-- the 3 non-sensitive columns a public intake form actually needs.

create or replace function get_company_by_subdomain(p_subdomain text)
returns table (id uuid, name text, subdomain text)
language sql
security definer
set search_path = public
stable
as $$
  select id, name, subdomain
  from companies
  where subdomain = lower(p_subdomain)
  limit 1;
$$;

grant execute on function get_company_by_subdomain(text) to anon, authenticated;

-- ---------------------------------------------------------
-- 2. company_id columns
-- ---------------------------------------------------------
alter table employees add column if not exists company_id uuid references companies(id);
alter table invite_codes add column if not exists company_id uuid references companies(id);
alter table jobs add column if not exists company_id uuid references companies(id);

-- ---------------------------------------------------------
-- 3. Backfill existing (demo) data into one company row
-- ---------------------------------------------------------
do $$
declare
  v_company_id uuid;
begin
  insert into companies (name, subdomain)
  values ('Demo Company', 'demo')
  returning id into v_company_id;

  update employees set company_id = v_company_id where company_id is null;
  update invite_codes set company_id = v_company_id where company_id is null;
  update jobs set company_id = v_company_id where company_id is null;
end $$;

-- ---------------------------------------------------------
-- 4. Enforce company_id going forward
-- ---------------------------------------------------------
alter table employees alter column company_id set not null;
alter table invite_codes alter column company_id set not null;
alter table jobs alter column company_id set not null;

-- ---------------------------------------------------------
-- 5. Helper: resolve the calling user's own company_id.
--    security definer + a single indexed lookup means this does NOT
--    recurse back through employees' own RLS policy.
-- ---------------------------------------------------------
create or replace function get_my_company_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select company_id from employees where user_id = auth.uid();
$$;

grant execute on function get_my_company_id() to authenticated;

-- ---------------------------------------------------------
-- 6. employees RLS: same-company only
-- ---------------------------------------------------------
drop policy if exists "employees_select_own" on employees;
drop policy if exists "employees_select_company" on employees;
create policy "employees_select_company"
on employees for select
to authenticated
using (company_id = get_my_company_id());
-- Still no insert/update/delete policy -- redeem_invite_code() is the
-- only path that writes to this table.

-- ---------------------------------------------------------
-- 7. jobs RLS: same-company only for reads; public insert goes
--    through submit_public_job() instead of a raw insert policy.
-- ---------------------------------------------------------
drop policy if exists "jobs_select_employees" on jobs;
drop policy if exists "jobs_select_company" on jobs;
create policy "jobs_select_company"
on jobs for select
to authenticated
using (company_id = get_my_company_id());

drop policy if exists "jobs_insert_public" on jobs;
-- No direct insert policy -- default-deny. submit_public_job() is the
-- only way a new job row gets created from the public intake form.

create or replace function submit_public_job(
  p_subdomain text,
  p_context text,
  p_fixture text,
  p_pipe text,
  p_access text,
  p_cutting text,
  p_preference text,
  p_leak_detection text,
  p_ai_job_type text,
  p_ai_urgency text,
  p_ai_materials text[],
  p_ai_summary text,
  p_ai_watch_out text
)
returns jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_job jobs%rowtype;
begin
  select id into v_company_id
  from companies
  where subdomain = lower(p_subdomain)
  limit 1;

  if v_company_id is null then
    raise exception 'Unknown company';
  end if;

  insert into jobs (
    company_id, context, fixture, pipe, access, cutting, preference,
    leak_detection, ai_job_type, ai_urgency, ai_materials, ai_summary,
    ai_watch_out, status
  ) values (
    v_company_id, p_context, p_fixture, p_pipe, p_access, p_cutting,
    p_preference, p_leak_detection, p_ai_job_type, p_ai_urgency,
    p_ai_materials, p_ai_summary, p_ai_watch_out, 'new'
  )
  returning * into v_job;

  return v_job;
end;
$$;

grant execute on function submit_public_job(
  text, text, text, text, text, text, text, text, text, text, text[], text, text
) to anon, authenticated;

-- ---------------------------------------------------------
-- 8. redeem_invite_code(): now assigns the new employee to the same
--    company as the invite code they redeemed.
-- ---------------------------------------------------------
create or replace function redeem_invite_code(
  invite_code text,
  employee_full_name text,
  employee_email text
)
returns employees
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invite_codes%rowtype;
  v_employee employees%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_invite
  from invite_codes
  where code = invite_code
  for update;

  if v_invite is null then
    raise exception 'Invalid invite code';
  end if;

  if v_invite.used_at is not null then
    raise exception 'Invite code already used';
  end if;

  if exists (select 1 from employees where user_id = auth.uid()) then
    raise exception 'This account already has a role assigned';
  end if;

  insert into employees (user_id, email, full_name, role, company_id)
  values (auth.uid(), employee_email, employee_full_name, v_invite.role, v_invite.company_id)
  returning * into v_employee;

  -- used_by references employees(id), which is the row's own generated
  -- primary key -- NOT auth.uid() (that's employees.user_id, a different
  -- column). Using auth.uid() here violated invite_codes_used_by_fkey
  -- because that value never exists as a row in employees.id.
  update invite_codes
  set used_at = now(), used_by = v_employee.id
  where id = v_invite.id;

  return v_employee;
end;
$$;

grant execute on function redeem_invite_code(text, text, text) to authenticated;
