-- Tier 1.6: Job notifications + missed-lead escalation
--
-- Context: the public intake form (ScopeIntake.jsx) was inserting into
-- public.jobs without ever setting company_id, and there was no INSERT
-- RLS policy on jobs at all. Combined, every real customer submission was
-- silently rejected by RLS -- the customer saw a fake "success" screen
-- (the insert error is caught and only console.error'd) while nothing
-- was ever saved. This migration fixes the INSERT path and adds the
-- columns needed for the claim / missed-lead-escalation feature.
--
-- Run this against staging first, verify an end-to-end test submission
-- lands and is visible/claimable, then run against production.

-- 1. Columns needed for claiming a job and tracking escalation state.
alter table public.jobs
  add column if not exists claimed_by uuid references public.employees(id),
  add column if not exists claimed_at timestamptz,
  add column if not exists missed_lead_alert_sent_at timestamptz;

-- Cheap index for the escalation cron's "find unclaimed jobs older than
-- N" query.
create index if not exists idx_jobs_unclaimed_created_at
  on public.jobs (created_at)
  where claimed_at is null;

-- 2. The INSERT policy that was missing. Anonymous customers (and logged
-- in staff, for completeness) may insert a job as long as company_id
-- points at a real company row. The public form resolves company_id via
-- the existing get_company_by_subdomain() function (already granted to
-- anon, already existed before this migration, just never called).
--
-- The WITH CHECK below intentionally does NOT query public.companies
-- directly. companies has RLS enabled with zero policies on it (by
-- design -- it's meant to be reached only through SECURITY DEFINER
-- functions like get_company_by_subdomain, never a direct table read).
-- A direct "company_id in (select id from companies)" subquery runs as
-- the calling role and would see zero rows regardless of table grants,
-- making the check silently always-false for anon. Using a small
-- SECURITY DEFINER helper (below) mirrors the existing
-- get_company_by_subdomain pattern and avoids having to open up direct
-- SELECT access to companies just to satisfy this check.
create or replace function public.company_exists(p_company_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists(select 1 from public.companies where id = p_company_id);
$$;

grant execute on function public.company_exists(uuid) to anon, authenticated;

drop policy if exists jobs_insert_public on public.jobs;
create policy jobs_insert_public
  on public.jobs
  for insert
  to anon, authenticated
  with check (
    company_id is not null
    and public.company_exists(company_id)
  );

-- 3. Defense in depth: even though the INSERT policy only checks
-- company_id, a public submitter could otherwise hand-craft a request
-- setting status/claimed_by/claimed_at/created_at directly (the anon key
-- is public in the browser bundle). Force those fields to safe values on
-- every insert regardless of what was submitted. ai_* fields are left
-- alone -- those are legitimately set by the client after the AI review
-- call completes.
create or replace function public.jobs_before_insert_lockdown()
returns trigger
language plpgsql
as $$
begin
  new.status := 'new';
  new.claimed_by := null;
  new.claimed_at := null;
  new.missed_lead_alert_sent_at := null;
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists jobs_before_insert_lockdown_trigger on public.jobs;
create trigger jobs_before_insert_lockdown_trigger
  before insert on public.jobs
  for each row
  execute function public.jobs_before_insert_lockdown();

-- 4. Table-level grants. An RLS policy alone is not enough -- Postgres
-- also requires the plain table-level privilege before RLS is even
-- evaluated. Production already had anon INSERT/SELECT on jobs from
-- Supabase's initial project setup, which is why this gap was invisible
-- there. Staging's schema-only sync (sync-staging.yml) does not carry
-- role grants, which is what caught this: a fresh environment built from
-- this migration alone would silently 42501 on every anon insert without
-- these lines. Idempotent -- safe to re-run, safe on an environment that
-- already has the grants.
grant usage on schema public to anon, authenticated;
grant insert, select on public.jobs to anon, authenticated;
grant update on public.jobs to authenticated;

-- Verified end-to-end on staging: as the anon role (not postgres, which
-- bypasses RLS), a plain insert() with no .select() chained -- exactly
-- what ScopeIntake.jsx does -- succeeds, and the row lands with
-- status='new', claimed_by=null, claimed_at=null regardless of what
-- values were submitted for those fields, confirming both the INSERT
-- policy and the lockdown trigger work correctly together.
