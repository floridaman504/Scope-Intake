-- ============ FORWARD ============
-- Multi-assignee support: job_assignees junction table + backward-compat sync
-- to jobs.claimed_by/claimed_at (kept as "primary assignee"), plus additive
-- RLS extension on the 7 job_estimates/job_estimate_line_items policies that
-- gate plumber access via claimed_by.

-- 1) Junction table
create table public.job_assignees (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references public.employees(id),
  unique (job_id, employee_id)
);

create index idx_job_assignees_job_id on public.job_assignees(job_id);
create index idx_job_assignees_employee_id on public.job_assignees(employee_id);

alter table public.job_assignees enable row level security;

create policy job_assignees_select_company on public.job_assignees
  for select to authenticated
  using (exists (select 1 from public.jobs j where j.id = job_assignees.job_id and j.company_id = get_my_company_id()));

create policy job_assignees_insert_owner_dispatcher on public.job_assignees
  for insert to authenticated
  with check (
    exists (select 1 from public.jobs j where j.id = job_assignees.job_id and j.company_id = get_my_company_id())
    and get_my_role() = any (array['owner','dispatcher'])
  );

create policy job_assignees_delete_owner_dispatcher on public.job_assignees
  for delete to authenticated
  using (
    exists (select 1 from public.jobs j where j.id = job_assignees.job_id and j.company_id = get_my_company_id())
    and get_my_role() = any (array['owner','dispatcher'])
  );

-- 2) Backfill existing single-assignee data
insert into public.job_assignees (job_id, employee_id, assigned_at, assigned_by)
select id, claimed_by, coalesce(claimed_at, now()), null
from public.jobs
where claimed_by is not null
on conflict (job_id, employee_id) do nothing;

-- 3) Sync trigger: jobs.claimed_by/claimed_at always mirrors the
-- earliest-assigned row in job_assignees ("primary" assignee), so every
-- existing single-assignee reader (missed-lead cron, old RLS, old UI)
-- keeps working unchanged.
create or replace function public.sync_jobs_claimed_by_from_assignees()
returns trigger
language plpgsql
as $$
declare
  v_job_id uuid;
  v_employee_id uuid;
  v_assigned_at timestamptz;
begin
  v_job_id := coalesce(new.job_id, old.job_id);

  select employee_id, assigned_at into v_employee_id, v_assigned_at
  from public.job_assignees
  where job_id = v_job_id
  order by assigned_at asc
  limit 1;

  update public.jobs
  set claimed_by = v_employee_id, claimed_at = v_assigned_at
  where id = v_job_id;

  return null;
end;
$$;

create trigger job_assignees_sync_claimed_by
after insert or delete on public.job_assignees
for each row execute function public.sync_jobs_claimed_by_from_assignees();

-- 4) Additively extend the 7 claimed_by-gated policies so ANY assigned
-- plumber (not just the primary one) gets estimate access on buddy jobs.
-- Pattern: everywhere the old policy checked
--   j.claimed_by = get_my_employee_id()
-- the new policy checks
--   (j.claimed_by = get_my_employee_id() OR EXISTS (
--      select 1 from public.job_assignees ja
--      where ja.job_id = j.id and ja.employee_id = get_my_employee_id()
--   ))

drop policy if exists job_estimate_line_items_delete on public.job_estimate_line_items;
create policy job_estimate_line_items_delete on public.job_estimate_line_items
  for delete to authenticated
  using (
    company_id = get_my_company_id()
    and exists (
      select 1 from job_estimates e join jobs j on j.id = e.job_id
      where e.id = job_estimate_line_items.estimate_id
        and e.status = 'draft'
        and (
          get_my_role() = 'owner'
          or (get_my_role() = 'dispatcher' and e.dispatcher_may_edit = true)
          or (get_my_role() = 'plumber' and (
                j.claimed_by = get_my_employee_id()
                or exists (select 1 from public.job_assignees ja where ja.job_id = j.id and ja.employee_id = get_my_employee_id())
              ))
        )
    )
  );

drop policy if exists job_estimate_line_items_insert on public.job_estimate_line_items;
create policy job_estimate_line_items_insert on public.job_estimate_line_items
  for insert to authenticated
  with check (
    company_id = get_my_company_id()
    and created_by = get_my_employee_id()
    and exists (
      select 1 from job_estimates e join jobs j on j.id = e.job_id
      where e.id = job_estimate_line_items.estimate_id
        and e.status = 'draft'
        and (
          get_my_role() = 'owner'
          or (get_my_role() = 'dispatcher' and e.dispatcher_may_edit = true)
          or (get_my_role() = 'plumber' and (
                j.claimed_by = get_my_employee_id()
                or exists (select 1 from public.job_assignees ja where ja.job_id = j.id and ja.employee_id = get_my_employee_id())
              ))
        )
    )
  );

drop policy if exists job_estimate_line_items_select on public.job_estimate_line_items;
create policy job_estimate_line_items_select on public.job_estimate_line_items
  for select to authenticated
  using (
    company_id = get_my_company_id()
    and exists (
      select 1 from job_estimates e join jobs j on j.id = e.job_id
      where e.id = job_estimate_line_items.estimate_id
        and (
          get_my_role() = any (array['owner','dispatcher'])
          or j.claimed_by = get_my_employee_id()
          or exists (select 1 from public.job_assignees ja where ja.job_id = j.id and ja.employee_id = get_my_employee_id())
        )
    )
  );

drop policy if exists job_estimate_line_items_update on public.job_estimate_line_items;
create policy job_estimate_line_items_update on public.job_estimate_line_items
  for update to authenticated
  using (
    company_id = get_my_company_id()
    and exists (
      select 1 from job_estimates e join jobs j on j.id = e.job_id
      where e.id = job_estimate_line_items.estimate_id
        and e.status = 'draft'
        and (
          get_my_role() = 'owner'
          or (get_my_role() = 'dispatcher' and e.dispatcher_may_edit = true)
          or (get_my_role() = 'plumber' and (
                j.claimed_by = get_my_employee_id()
                or exists (select 1 from public.job_assignees ja where ja.job_id = j.id and ja.employee_id = get_my_employee_id())
              ))
        )
    )
  )
  with check (
    company_id = get_my_company_id()
    and exists (
      select 1 from job_estimates e join jobs j on j.id = e.job_id
      where e.id = job_estimate_line_items.estimate_id
        and e.status = 'draft'
        and (
          get_my_role() = 'owner'
          or (get_my_role() = 'dispatcher' and e.dispatcher_may_edit = true)
          or (get_my_role() = 'plumber' and (
                j.claimed_by = get_my_employee_id()
                or exists (select 1 from public.job_assignees ja where ja.job_id = j.id and ja.employee_id = get_my_employee_id())
              ))
        )
    )
  );

drop policy if exists job_estimates_insert on public.job_estimates;
create policy job_estimates_insert on public.job_estimates
  for insert to authenticated
  with check (
    company_id = get_my_company_id()
    and status = 'draft'
    and created_by = get_my_employee_id()
    and (
      get_my_role() = any (array['owner','dispatcher'])
      or exists (
        select 1 from jobs j where j.id = job_estimates.job_id
          and (
            j.claimed_by = get_my_employee_id()
            or exists (select 1 from public.job_assignees ja where ja.job_id = j.id and ja.employee_id = get_my_employee_id())
          )
      )
    )
  );

drop policy if exists job_estimates_select on public.job_estimates;
create policy job_estimates_select on public.job_estimates
  for select to authenticated
  using (
    company_id = get_my_company_id()
    and (
      get_my_role() = any (array['owner','dispatcher'])
      or exists (
        select 1 from jobs j where j.id = job_estimates.job_id
          and (
            j.claimed_by = get_my_employee_id()
            or exists (select 1 from public.job_assignees ja where ja.job_id = j.id and ja.employee_id = get_my_employee_id())
          )
      )
    )
  );

drop policy if exists job_estimates_update_plumber_own_draft on public.job_estimates;
create policy job_estimates_update_plumber_own_draft on public.job_estimates
  for update to authenticated
  using (
    company_id = get_my_company_id()
    and get_my_role() = 'plumber'
    and status = 'draft'
    and exists (
      select 1 from jobs j where j.id = job_estimates.job_id
        and (
          j.claimed_by = get_my_employee_id()
          or exists (select 1 from public.job_assignees ja where ja.job_id = j.id and ja.employee_id = get_my_employee_id())
        )
    )
  )
  with check (
    company_id = get_my_company_id()
    and get_my_role() = 'plumber'
    and status = 'draft'
    and exists (
      select 1 from jobs j where j.id = job_estimates.job_id
        and (
          j.claimed_by = get_my_employee_id()
          or exists (select 1 from public.job_assignees ja where ja.job_id = j.id and ja.employee_id = get_my_employee_id())
        )
    )
  );

-- ============ ROLLBACK ============
-- drop trigger if exists job_assignees_sync_claimed_by on public.job_assignees;
-- drop function if exists public.sync_jobs_claimed_by_from_assignees();
-- drop table if exists public.job_assignees;
-- (then re-run the original 7 CREATE POLICY statements without the job_assignees OR-clause,
--  captured verbatim in this session's research before this migration)

-- ============ HOW TO VERIFY IT WORKED ============
-- select count(*) from job_assignees; -- should be > 0 if any jobs were already claimed
-- select j.id, j.claimed_by, ja.employee_id from jobs j join job_assignees ja on ja.job_id = j.id where j.claimed_by is not null limit 5; -- claimed_by should match one of the job's assignees
-- insert a second job_assignees row for an already-assigned job and confirm claimed_by does NOT change (stays as earliest assigned_at)
-- delete the primary assignee's row and confirm claimed_by shifts to the next-earliest remaining assignee
