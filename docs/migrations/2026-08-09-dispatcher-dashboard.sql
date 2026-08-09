-- Migration: dispatcher dashboard (task #24, P2) -- job status workflow,
-- job notes, and the data needed for a workload summary.
-- Date: 2026-08-09
-- Author: Dante (via Claude)
--
-- Expand-contract stage: Expand only. Adds a CHECK constraint that widens
-- (not narrows) what's already true of every existing row, plus one new
-- table. Nothing existing code does today stops working: JobsQueue.jsx's
-- current claim flow (set claimed_by/claimed_at, status stays 'new') is
-- still valid under the new constraint.
--
-- WHAT THIS DOES
-- 1. Formalizes `jobs.status` with an explicit workflow instead of a free
--    -text column with no enforced values: new -> assigned -> in_progress
--    -> done, plus cancelled (a dispatcher-reachable soft-delete -- see
--    below). Verified before writing this: all 13 production rows are
--    currently 'new', so this constraint cannot fail on existing data.
-- 2. Adds `job_notes`, an append-only notes thread per job (no update/
--    delete policy on purpose -- this is meant to read like a log of what
--    was said/decided, not an editable scratchpad; if that turns out to
--    be wrong in practice, loosening it later is a small follow-up
--    migration, not a redesign).
--
-- DELIBERATE DESIGN CHOICE: no new "assigned_to" column. A dispatcher
-- assigning a job to a specific plumber reuses the existing claimed_by /
-- claimed_at columns -- assigning IS claiming, just performed by a
-- dispatcher/owner on someone else's behalf instead of a plumber
-- self-claiming. This means the existing jobs_update_owner_dispatcher_
-- company RLS policy already covers assignment AND reassignment/override
-- with zero policy changes -- owner and dispatcher can both already
-- UPDATE any of their company's jobs, including changing who it's
-- assigned to. "Owner override" is therefore a UI-layer distinction
-- (which buttons render), not a new permission -- RLS already treats
-- owner and dispatcher identically for jobs UPDATE.
--
-- DELIBERATE DESIGN CHOICE: cancellation is a status, not a DELETE. The
-- 2026-08-06 audit deliberately restricted hard DELETE on jobs to owners
-- only (jobs_delete_owner_company). Dispatchers needing to "delete" a job
-- for a cancellation get a `cancelled` status instead -- reversible, keeps
-- the row (and its history/notes) intact for reporting, and requires zero
-- change to the owner-only DELETE policy. The dispatcher dashboard UI
-- filters cancelled jobs out of the default active view.
--
-- job_notes access is owner+dispatcher only (not plumber), matching who
-- has access to /jobs today (ProtectedRoute allowedRoles=['owner',
-- 'dispatcher'] in main.jsx) -- this migration doesn't change that route
-- gate, just gives the page more to show within it.
--
-- REMEMBER: job_notes needs a grant in sync-staging.yml's "Reapply anon/
-- authenticated grants" step too, or the next staging resync silently
-- strips it (this is exactly the bug task #23 found and fixed for the
-- existing tables -- don't repeat it for a new one).
--
-- HOW TO VERIFY IT WORKED
-- select conname from pg_constraint where conrelid = 'public.jobs'::regclass and contype = 'c';
--   -> should include jobs_status_check
-- update jobs set status = 'not_a_real_status' where id = '<any id>';
--   -> should fail with a check constraint violation
-- insert into job_notes (job_id, company_id, author_employee_id, body)
--   values ('<a real job id>', '<matching company_id>', '<a real employee id>', 'test note');
--   -> should succeed as postgres (bypasses RLS); as authenticated
--      dispatcher/owner via the app it should also succeed; as plumber or
--      cross-company it should be rejected
-- select grantee, privilege_type from information_schema.role_table_grants
--   where table_name = 'job_notes';
--   -> anon should have ZERO rows; authenticated should have exactly
--      INSERT and SELECT, nothing else

-- ============================== FORWARD ====================================

alter table public.jobs
  add constraint jobs_status_check
  check (status in ('new', 'assigned', 'in_progress', 'done', 'cancelled'));

create table if not exists public.job_notes (
    id                  uuid not null default gen_random_uuid(),
    job_id              uuid not null references public.jobs(id) on delete cascade,
    company_id          uuid not null references public.companies(id),
    author_employee_id  uuid not null references public.employees(id),
    body                text not null,
    created_at          timestamptz not null default now(),
    constraint job_notes_pkey primary key (id)
  );

create index if not exists job_notes_job_id_idx on public.job_notes(job_id);

alter table public.job_notes enable row level security;

create policy job_notes_select_company_dispatch on public.job_notes
  for select to authenticated
  using (
      company_id = get_my_company_id()
      and get_my_role() in ('owner', 'dispatcher')
    );

create policy job_notes_insert_company_dispatch on public.job_notes
  for insert to authenticated
  with check (
      company_id = get_my_company_id()
      and get_my_role() in ('owner', 'dispatcher')
      and author_employee_id in (select id from public.employees where user_id = auth.uid())
    );

grant select, insert on public.job_notes to authenticated;

-- IMPORTANT: Supabase's own default ACL (checked via pg_default_acl,
-- defaclrole = postgres) grants ALL privileges on every newly-created
-- table in public to both anon and authenticated automatically -- this
-- is a platform default, not something this project set, and it applies
-- silently to every `create table`. Confirmed live: right after the
-- `create table` above ran (before this revoke), anon already had
-- INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on job_notes,
-- and authenticated had those same privileges beyond the select+insert
-- granted above. RLS backstops this (no anon policy exists, so anon's
-- access is still default-denied at the row level, and job_notes has no
-- update/delete policy for authenticated either) -- but per the task #22
-- audit's own principle, don't rely on RLS alone; tighten the GRANT layer
-- too, so a future policy bug doesn't silently open a second hole. This
-- is the exact same class of gap task #22 fixed for the pre-existing
-- tables -- it just resets itself for every NEW table, so it has to be
-- redone here. Confirmed via pg_default_acl that this default is owned
-- by the `postgres` role specifically (the role every migration in this
-- project runs as), not a one-off fluke.
revoke all on public.job_notes from anon;
revoke truncate, trigger, references, update, delete on public.job_notes from authenticated;

-- ============================== ROLLBACK ===================================
-- Exact inverse of everything above. Run this to fully undo the migration.

-- revoke select, insert on public.job_notes from authenticated;
-- drop policy if exists job_notes_insert_company_dispatch on public.job_notes;
-- drop policy if exists job_notes_select_company_dispatch on public.job_notes;
-- drop table if exists public.job_notes;
-- alter table public.jobs drop constraint if exists jobs_status_check;
