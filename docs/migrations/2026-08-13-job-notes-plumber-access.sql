-- 2026-08-13: Plumber read/write access to job_notes, scoped to jobs
-- they're assigned to.
--
-- Context: Dante's jobs-view requirement -- "plumber notes live on the
-- jobs is instantly transmitted and displayed to the owner and dispatcher"
-- -- requires plumbers to actually be able to WRITE notes at all, which
-- they cannot do today. job_notes' existing policies
-- (job_notes_select_company_dispatch / job_notes_insert_company_dispatch,
-- 2026-08-09-dispatcher-dashboard.sql) are owner+dispatcher only by
-- design (see that file's header comment) with no update/delete policy
-- at all. JobNotes.jsx is also only mounted for those two roles today.
--
-- This is purely additive: two new policies, scoped to job assignment via
-- job_assignees (the same multi-assignee source of truth used everywhere
-- else in this schema -- 2026-08-10-job-assignees-multi-assignee.sql).
-- Postgres RLS policies for the same command are OR'd together, so this
-- does not touch or narrow the existing owner/dispatcher policies at all
-- -- owner and dispatcher keep exactly the behavior they have today, and
-- plumbers gain a strictly new, narrower path.
--
-- No new GRANT needed: `grant select, insert on public.job_notes to
-- authenticated` (already present) is a single Postgres-role grant that
-- already covers plumbers -- RLS policies are what was blocking them, not
-- the grant.
--
-- Still no UPDATE/DELETE policy on job_notes for anyone, plumber included
-- -- notes remain append-only, unchanged from the existing design.

create policy job_notes_select_assigned_plumber on public.job_notes
  for select to authenticated
  using (
    company_id = get_my_company_id()
    and get_my_role() = 'plumber'
    and exists (
      select 1 from public.job_assignees ja
      where ja.job_id = job_notes.job_id and ja.employee_id = get_my_employee_id()
    )
  );

create policy job_notes_insert_assigned_plumber on public.job_notes
  for insert to authenticated
  with check (
    company_id = get_my_company_id()
    and get_my_role() = 'plumber'
    and author_employee_id = get_my_employee_id()
    and exists (
      select 1 from public.job_assignees ja
      where ja.job_id = job_notes.job_id and ja.employee_id = get_my_employee_id()
    )
  );

-- Verification queries (run after applying):
--   select policyname from pg_policies where tablename = 'job_notes' order by policyname;
--   -- expect 4 rows: the 2 existing owner/dispatcher ones + these 2 new ones
--   -- as a plumber assigned to job X: select/insert into job_notes for job X -- should succeed
--   -- as a plumber NOT assigned to job X: same -- should return 0 rows / fail the check
--   -- as owner/dispatcher: unaffected, confirm existing behavior still works

-- ============ ROLLBACK ============
-- drop policy if exists job_notes_insert_assigned_plumber on public.job_notes;
-- drop policy if exists job_notes_select_assigned_plumber on public.job_notes;
