-- Migration: dispatcher dashboard Phase 1 -- pricing estimator + owner
-- superiority on job assignment (task #24 follow-on).
-- Date: 2026-08-09
-- Author: Dante (via Claude)
--
-- Expand-contract stage: Expand only. Three new tables, one new column on
-- employees, one new trigger on jobs, two new SECURITY DEFINER functions.
-- Nothing existing breaks: jobs.status/claimed_by behavior is unchanged
-- except for the new assignment-lock trigger, which only fires on a very
-- specific case (see below) that nothing in production currently does.
--
-- WHAT THIS DOES, AND WHY
--
-- 1. PRICEBOOK (`pricebook_items`): a company's own rate sheet -- labor
--    rate(s), material costs, fees -- tagged by realm (service / remodel /
--    new_construction / commercial / all). Owner-editable only. Everyone
--    who can draft an estimate (owner, dispatcher, assigned plumber) can
--    read it, because you can't build an estimate without seeing the
--    rates. This replaces "live web research" of material costs with an
--    internal, editable reference list -- reliable, no external data
--    dependency, and the owner controls what's in it. Ships with Service
--    realm populated meaningfully; Remodel/New Construction/Commercial
--    ship as starter categories the owner fills in over time (Phase 2,
--    tracked separately and NOT part of this migration, is a possible
--    future live/external pricing feed -- only worth it if this proves
--    insufficient).
--
-- 2. ESTIMATES (`job_estimates` + `job_estimate_line_items`): one
--    estimate per job (v1 -- one active estimate, not a version history;
--    widening to multiple/versioned estimates later is a small additive
--    migration, not a redesign, if that's ever needed). Each estimate has
--    a realm and a status of 'draft' or 'approved'. Line items reference
--    a pricebook item (or are ad-hoc, pricebook_item_id nullable) with a
--    quantity and unit cost.
--
--    Draft editing access (who can touch a job_estimates/line_items row
--    while status = 'draft'):
--      - owner: always
--      - dispatcher: only if this specific job's estimate has
--        dispatcher_may_edit = true -- an owner-controlled per-job toggle,
--        off by default. This is "augmentation only" per Dante: the
--        dispatcher can add to a draft the plumber started, not override
--        or finalize it.
--      - the assigned plumber (jobs.claimed_by = their own employee id):
--        only on their own assigned job.
--    Nobody else (including other plumbers, or a dispatcher without the
--    toggle) can touch a draft at all -- default deny via RLS.
--
-- 3. APPROVAL is deliberately NOT a plain UPDATE. Every plain UPDATE
--    policy on job_estimates below requires the resulting row to still
--    have status = 'draft' -- so nobody, not even the owner, can flip
--    status to 'approved' via a normal UPDATE. The only way to approve is
--    the new `approve_job_estimate()` function, which:
--      - checks the caller is the owner OR has employees.can_approve_pricing
--        = true for this company (see #4 below) -- raises otherwise
--      - sets status = 'approved', approved_by, approved_at
--      - sets final_total = the sum of line items, UNLESS an
--        override_total is passed, in which case that's the final number
--    This means "the owner doesn't like what the calculator generated, so
--    they type their own number" and "the owner approves the calculated
--    number as-is" are the SAME action, not two features -- exactly what
--    Dante asked for. This also guarantees approved_by/approved_at are
--    always reliably set (no risk of a manual UPDATE bypassing the audit
--    trail), which plain RLS policies alone can't guarantee since Postgres
--    RLS has no column-level granularity.
--
-- 4. DELEGATED APPROVAL (`employees.can_approve_pricing`): a new boolean
--    column, default false. `employees` currently has ZERO update policy
--    at all (checked in the current production schema dump -- only a
--    SELECT policy exists), so there is no "just add a WHERE role=owner
--    to an UPDATE policy" option here without opening a much bigger
--    surface (any column, by whoever the policy allows). Instead, per the
--    same pattern this codebase already uses for owner-only actions on
--    OTHER employees (see revoke_session, sign_out_everywhere in the
--    current schema -- both SECURITY DEFINER functions that check
--    "is the caller the owner of this target's company" internally rather
--    than via a table policy), this adds `set_pricing_approver()`: owner
--    only, same company, sets exactly one column on exactly one target
--    employee. employees.can_approve_pricing is NOT reachable by any
--    other path -- no UPDATE policy is added to employees itself.
--
-- 5. ASSIGNMENT LOCK (new trigger `jobs_before_update_assignment_lock`):
--    per Dante, "owner can override any dispatcher assignment" -- once a
--    job has an assignee (claimed_by is not null), a dispatcher can no
--    longer change WHO it's assigned to; only the owner can reassign from
--    that point on. This is deliberately a TRIGGER, not an RLS policy
--    change, because RLS's USING/WITH CHECK can't express "block changing
--    THIS ONE COLUMN specifically, but allow changing every other column
--    normally" -- RLS is row-level, not column-level. A BEFORE UPDATE
--    trigger comparing OLD.claimed_by to NEW.claimed_by is the same
--    technique already used in this schema for jobs_before_insert_lockdown.
--    Confirmed this does NOT block the existing dispatcher UPDATE test in
--    scripts/cross-tenant-isolation-test.mjs: that test's job has
--    claimed_by = null throughout (it only changes status), so
--    OLD.claimed_by IS NOT NULL is false and the trigger never fires for
--    it. Will still re-run CI after this migration to confirm.
--    NOTE: this only restricts changing claimed_by. Dispatchers keep full
--    ability to move a job through the normal status workflow
--    (new/assigned/in_progress/done/cancelled) on any of their company's
--    jobs -- assignment and status are independent; nothing here changes
--    jobs_update_owner_dispatcher_company for status changes.
--
-- 6. Plumber self-assignment: NOT addressed here because it's already
--    impossible today -- plumbers have no UPDATE grant/policy on jobs at
--    all (jobs_update_owner_dispatcher_company only allows owner/
--    dispatcher). This was verified against the current production
--    schema dump before writing this migration. The only change needed
--    for "plumbers can't self-assign" is on the UI side (task #41):
--    JobsQueue.jsx's current self-claim button needs to become a
--    dispatcher/owner-driven assignment control instead.
--
-- REMEMBER: pricebook_items, job_estimates, and job_estimate_line_items
-- all need a grant added in sync-staging.yml's "Reapply anon/authenticated
-- grants" step, same as job_notes did -- tracked as a follow-up task, do
-- not forget it (this is the exact bug task #23 found and task #24 had to
-- re-fix once already).
--
-- HOW TO VERIFY IT WORKED
-- select conname from pg_constraint where conrelid = 'public.job_estimates'::regclass and contype = 'c';
--   -> should include job_estimates_realm_check, job_estimates_status_check
-- select grantee, privilege_type from information_schema.role_table_grants
--   where table_name in ('pricebook_items','job_estimates','job_estimate_line_items')
--   order by table_name, grantee, privilege_type;
--   -> anon: ZERO rows for all three. authenticated: pricebook_items has
--      select/insert/update/delete; job_estimates has select/insert/update
--      (no delete); job_estimate_line_items has select/insert/update/delete.
-- As a dispatcher, try: update job_estimates set status = 'approved' where id = '<any>';
--   -> should affect 0 rows / fail the RLS check (status must be 'draft'
--      for the plain-update policies to apply) -- approval only via
--      approve_job_estimate().
-- As a dispatcher, on a job that already has claimed_by set: try to change
-- claimed_by to someone else via UPDATE jobs.
--   -> should fail with "Only the owner can reassign a job that already
--      has an assignee" (raised by jobs_before_update_assignment_lock).
-- As owner: select set_pricing_approver('<employee id>', true);
--   -> should succeed, and that employee's can_approve_pricing should now
--      be true. As a non-owner calling the same function: should raise.

-- ============================== FORWARD ====================================

-- ---- Helper: caller's own employee id, same STABLE/SECURITY DEFINER style
-- ---- as get_my_company_id()/get_my_role() already in production. ----
create or replace function public.get_my_employee_id()
returns uuid
language sql stable security definer
set search_path to 'public'
as $function$
  select id from employees where user_id = auth.uid();
$function$;

-- ---- Pricebook ----

create table if not exists public.pricebook_items (
    id          uuid not null default gen_random_uuid(),
    company_id  uuid not null references public.companies(id),
    realm       text not null check (realm in ('service', 'remodel', 'new_construction', 'commercial', 'all')),
    category    text not null check (category in ('labor', 'material', 'fee')),
    name        text not null,
    unit        text not null default 'each',
    unit_cost   numeric not null default 0,
    created_at  timestamptz not null default now(),
    constraint pricebook_items_pkey primary key (id)
  );

create index if not exists pricebook_items_company_id_idx on public.pricebook_items(company_id);

alter table public.pricebook_items enable row level security;

create policy pricebook_items_select_company on public.pricebook_items
  for select to authenticated
  using (company_id = get_my_company_id());

create policy pricebook_items_write_owner on public.pricebook_items
  for all to authenticated
  using (company_id = get_my_company_id() and get_my_role() = 'owner')
  with check (company_id = get_my_company_id() and get_my_role() = 'owner');

grant select, insert, update, delete on public.pricebook_items to authenticated;
revoke all on public.pricebook_items from anon;
revoke truncate, trigger, references on public.pricebook_items from authenticated;

-- ---- Estimates ----

create table if not exists public.job_estimates (
    id                    uuid not null default gen_random_uuid(),
    job_id                uuid not null references public.jobs(id) on delete cascade,
    company_id            uuid not null references public.companies(id),
    realm                 text not null check (realm in ('service', 'remodel', 'new_construction', 'commercial')),
    status                text not null default 'draft' check (status in ('draft', 'approved')),
    dispatcher_may_edit   boolean not null default false,
    final_total           numeric,
    approved_by           uuid references public.employees(id),
    approved_at           timestamptz,
    created_by            uuid references public.employees(id),
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    constraint job_estimates_pkey primary key (id),
    constraint job_estimates_job_id_key unique (job_id)
  );

create index if not exists job_estimates_job_id_idx on public.job_estimates(job_id);

alter table public.job_estimates enable row level security;

create policy job_estimates_select on public.job_estimates
  for select to authenticated
  using (
    company_id = get_my_company_id()
    and (
      get_my_role() in ('owner', 'dispatcher')
      or exists (
        select 1 from public.jobs j
        where j.id = job_estimates.job_id and j.claimed_by = get_my_employee_id()
      )
    )
  );

create policy job_estimates_insert on public.job_estimates
  for insert to authenticated
  with check (
    company_id = get_my_company_id()
    and status = 'draft'
    and created_by = get_my_employee_id()
    and (
      get_my_role() in ('owner', 'dispatcher')
      or exists (
        select 1 from public.jobs j
        where j.id = job_estimates.job_id and j.claimed_by = get_my_employee_id()
      )
    )
  );

-- Three separate named UPDATE policies, deliberately not combined, because
-- this is the exact mechanism enforcing "owner superiority" and
-- "dispatcher augmentation only" -- worth keeping each independently
-- readable rather than folding into one big OR.

create policy job_estimates_update_owner on public.job_estimates
  for update to authenticated
  using (company_id = get_my_company_id() and get_my_role() = 'owner' and status = 'draft')
  with check (company_id = get_my_company_id() and get_my_role() = 'owner' and status = 'draft');

create policy job_estimates_update_dispatcher_augment on public.job_estimates
  for update to authenticated
  using (company_id = get_my_company_id() and get_my_role() = 'dispatcher' and status = 'draft' and dispatcher_may_edit = true)
  with check (company_id = get_my_company_id() and get_my_role() = 'dispatcher' and status = 'draft' and dispatcher_may_edit = true);

create policy job_estimates_update_plumber_own_draft on public.job_estimates
  for update to authenticated
  using (
    company_id = get_my_company_id() and get_my_role() = 'plumber' and status = 'draft'
    and exists (select 1 from public.jobs j where j.id = job_estimates.job_id and j.claimed_by = get_my_employee_id())
  )
  with check (
    company_id = get_my_company_id() and get_my_role() = 'plumber' and status = 'draft'
    and exists (select 1 from public.jobs j where j.id = job_estimates.job_id and j.claimed_by = get_my_employee_id())
  );

-- No delete policy, on purpose -- same minimalism as job_notes. An
-- unwanted draft can just be left as-is or superseded later; deleting
-- estimate history isn't something this needs yet.

grant select, insert, update on public.job_estimates to authenticated;
revoke all on public.job_estimates from anon;
revoke truncate, trigger, references, delete on public.job_estimates from authenticated;

-- ---- Estimate line items ----

create table if not exists public.job_estimate_line_items (
    id                  uuid not null default gen_random_uuid(),
    estimate_id         uuid not null references public.job_estimates(id) on delete cascade,
    company_id          uuid not null references public.companies(id),
    pricebook_item_id   uuid references public.pricebook_items(id),
    description         text not null,
    line_type           text not null check (line_type in ('labor', 'material', 'fee')),
    quantity            numeric not null default 1,
    unit_cost           numeric not null default 0,
    created_by          uuid references public.employees(id),
    created_at          timestamptz not null default now(),
    constraint job_estimate_line_items_pkey primary key (id)
  );

create index if not exists job_estimate_line_items_estimate_id_idx on public.job_estimate_line_items(estimate_id);

alter table public.job_estimate_line_items enable row level security;

create policy job_estimate_line_items_select on public.job_estimate_line_items
  for select to authenticated
  using (
    company_id = get_my_company_id()
    and exists (
      select 1 from public.job_estimates e
      join public.jobs j on j.id = e.job_id
      where e.id = job_estimate_line_items.estimate_id
      and (get_my_role() in ('owner', 'dispatcher') or j.claimed_by = get_my_employee_id())
    )
  );

-- Insert/update/delete share the same "can I edit this draft" condition,
-- so unlike job_estimates these are combined into one policy per action
-- rather than split three ways -- the owner/dispatcher-toggle/plumber-own
-- logic here is a straight mirror of job_estimates' update policies, not
-- a new decision, so splitting it again would just be duplication.

create policy job_estimate_line_items_insert on public.job_estimate_line_items
  for insert to authenticated
  with check (
    company_id = get_my_company_id()
    and created_by = get_my_employee_id()
    and exists (
      select 1 from public.job_estimates e
      join public.jobs j on j.id = e.job_id
      where e.id = job_estimate_line_items.estimate_id
      and e.status = 'draft'
      and (
        get_my_role() = 'owner'
        or (get_my_role() = 'dispatcher' and e.dispatcher_may_edit = true)
        or (get_my_role() = 'plumber' and j.claimed_by = get_my_employee_id())
      )
    )
  );

create policy job_estimate_line_items_update on public.job_estimate_line_items
  for update to authenticated
  using (
    company_id = get_my_company_id()
    and exists (
      select 1 from public.job_estimates e
      join public.jobs j on j.id = e.job_id
      where e.id = job_estimate_line_items.estimate_id
      and e.status = 'draft'
      and (
        get_my_role() = 'owner'
        or (get_my_role() = 'dispatcher' and e.dispatcher_may_edit = true)
        or (get_my_role() = 'plumber' and j.claimed_by = get_my_employee_id())
      )
    )
  )
  with check (
    company_id = get_my_company_id()
    and exists (
      select 1 from public.job_estimates e
      join public.jobs j on j.id = e.job_id
      where e.id = job_estimate_line_items.estimate_id
      and e.status = 'draft'
      and (
        get_my_role() = 'owner'
        or (get_my_role() = 'dispatcher' and e.dispatcher_may_edit = true)
        or (get_my_role() = 'plumber' and j.claimed_by = get_my_employee_id())
      )
    )
  );

create policy job_estimate_line_items_delete on public.job_estimate_line_items
  for delete to authenticated
  using (
    company_id = get_my_company_id()
    and exists (
      select 1 from public.job_estimates e
      join public.jobs j on j.id = e.job_id
      where e.id = job_estimate_line_items.estimate_id
      and e.status = 'draft'
      and (
        get_my_role() = 'owner'
        or (get_my_role() = 'dispatcher' and e.dispatcher_may_edit = true)
        or (get_my_role() = 'plumber' and j.claimed_by = get_my_employee_id())
      )
    )
  );

grant select, insert, update, delete on public.job_estimate_line_items to authenticated;
revoke all on public.job_estimate_line_items from anon;
revoke truncate, trigger, references on public.job_estimate_line_items from authenticated;

-- ---- Delegated pricing-approval permission ----

alter table public.employees add column if not exists can_approve_pricing boolean not null default false;

-- No UPDATE policy added to employees -- can_approve_pricing is reachable
-- ONLY through this function, matching revoke_session/sign_out_everywhere's
-- existing pattern of internal owner-of-target-company checks instead of a
-- broad table policy.
create or replace function public.set_pricing_approver(p_employee_id uuid, p_can_approve boolean)
returns public.employees
language plpgsql security definer
set search_path to 'public'
as $function$
declare
  v_target employees%rowtype;
begin
  if get_my_role() <> 'owner' then
    raise exception 'Only the owner can grant or revoke pricing-approval permission';
  end if;
  select * into v_target from employees where id = p_employee_id;
  if v_target is null or v_target.company_id <> get_my_company_id() then
    raise exception 'Employee not found in your company';
  end if;
  update employees set can_approve_pricing = p_can_approve where id = p_employee_id;
  select * into v_target from employees where id = p_employee_id;
  return v_target;
end;
$function$;

-- ---- Approval (the only path to status = 'approved') ----

create or replace function public.approve_job_estimate(p_estimate_id uuid, p_override_total numeric default null)
returns public.job_estimates
language plpgsql security definer
set search_path to 'public'
as $function$
declare
  v_estimate job_estimates%rowtype;
  v_computed_total numeric;
begin
  select * into v_estimate from job_estimates where id = p_estimate_id;
  if v_estimate is null or v_estimate.company_id <> get_my_company_id() then
    raise exception 'Estimate not found in your company';
  end if;
  if not (get_my_role() = 'owner' or (select can_approve_pricing from employees where id = get_my_employee_id())) then
    raise exception 'Not authorized to approve pricing';
  end if;
  if v_estimate.status <> 'draft' then
    raise exception 'Estimate is not in draft status';
  end if;

  select coalesce(sum(quantity * unit_cost), 0) into v_computed_total
  from job_estimate_line_items where estimate_id = p_estimate_id;

  update job_estimates
  set status = 'approved',
      final_total = coalesce(p_override_total, v_computed_total),
      approved_by = get_my_employee_id(),
      approved_at = now(),
      updated_at = now()
  where id = p_estimate_id
  returning * into v_estimate;

  return v_estimate;
end;
$function$;

-- ---- Assignment lock: owner can always reassign; dispatcher cannot once
-- ---- a job already has an assignee. ----

create or replace function public.jobs_before_update_assignment_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if OLD.claimed_by is not null
     and NEW.claimed_by is distinct from OLD.claimed_by
     and coalesce(get_my_role(), '') = 'dispatcher' then
    raise exception 'Only the owner can reassign a job that already has an assignee';
  end if;
  return NEW;
end;
$function$;

create trigger jobs_before_update_assignment_lock_trigger
  before update on public.jobs
  for each row execute function jobs_before_update_assignment_lock();

-- ============================== ROLLBACK ===================================
-- Exact inverse of everything above. Run this to fully undo the migration.

-- drop trigger if exists jobs_before_update_assignment_lock_trigger on public.jobs;
-- drop function if exists public.jobs_before_update_assignment_lock();
-- drop function if exists public.approve_job_estimate(uuid, numeric);
-- drop function if exists public.set_pricing_approver(uuid, boolean);
-- alter table public.employees drop column if exists can_approve_pricing;
-- revoke select, insert, update, delete on public.job_estimate_line_items from authenticated;
-- drop policy if exists job_estimate_line_items_delete on public.job_estimate_line_items;
-- drop policy if exists job_estimate_line_items_update on public.job_estimate_line_items;
-- drop policy if exists job_estimate_line_items_insert on public.job_estimate_line_items;
-- drop policy if exists job_estimate_line_items_select on public.job_estimate_line_items;
-- drop table if exists public.job_estimate_line_items;
-- revoke select, insert, update on public.job_estimates from authenticated;
-- drop policy if exists job_estimates_update_plumber_own_draft on public.job_estimates;
-- drop policy if exists job_estimates_update_dispatcher_augment on public.job_estimates;
-- drop policy if exists job_estimates_update_owner on public.job_estimates;
-- drop policy if exists job_estimates_insert on public.job_estimates;
-- drop policy if exists job_estimates_select on public.job_estimates;
-- drop table if exists public.job_estimates;
-- revoke select, insert, update, delete on public.pricebook_items from authenticated;
-- drop policy if exists pricebook_items_write_owner on public.pricebook_items;
-- drop policy if exists pricebook_items_select_company on public.pricebook_items;
-- drop table if exists public.pricebook_items;
-- drop function if exists public.get_my_employee_id();
