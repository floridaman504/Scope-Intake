-- 2026-08-12: Employee deactivation (soft delete) + unique (company_id, email)
-- constraint on employees (Priority 1b + 1c)
--
-- Context: database/storage audit. Bundled into one file because both items
-- touch employees and are additive/low-risk (expand-only -- nothing is
-- dropped, nothing existing is modified in a way that could break current
-- data or queries).
--
-- ---------------------------------------------------------------------------
-- PRE-FLIGHT (run this FIRST, separately -- not part of the transaction
-- below). If it returns any rows, resolve those duplicates by hand before
-- applying this migration, or the UNIQUE constraint add will fail:
--
--   select company_id, email, count(*) from employees group by 1, 2 having count(*) > 1;
-- ---------------------------------------------------------------------------
--
-- 1b — Employee deactivation, not hard delete.
-- employees_company_id_fkey, invite_codes_created_by_fkey,
-- invite_codes_used_by_fkey, and jobs_claimed_by_fkey all have no ON DELETE
-- clause (Postgres default: NO ACTION, blocks the delete) -- and there's no
-- employee-removal flow at all today. Rather than pick an ON DELETE
-- behavior for a hard delete, this adds a deactivated_at column instead:
-- deactivated employees keep their full history (job assignments, invite
-- codes, audit trail) with correct attribution, and simply lose access.
--
-- The real enforcement point is get_my_company_id()/get_my_role() below,
-- not just an app-side check -- every RLS policy in this schema keys off
-- one of those two functions, so making them return NULL for a deactivated
-- employee makes every RLS-gated table deny-all for that employee
-- immediately, even if their JWT is still technically valid.
--
-- 1c — employees.email currently has no direct unique constraint -- only
-- indirectly protected via auth.users' unique email + employees.user_id
-- being unique. Adding it explicitly at the (company_id, email) grain
-- (not a bare unique on email, since email uniqueness here should be
-- per-company, not global).

alter table employees add column if not exists deactivated_at timestamptz;

alter table employees
  add constraint employees_company_email_unique unique (company_id, email);

create or replace function public.get_my_company_id()
returns uuid
language sql stable security definer
set search_path to 'public'
as $function$
  select company_id from employees where user_id = auth.uid() and deactivated_at is null;
$function$;

create or replace function public.get_my_role()
returns text
language sql stable security definer
set search_path to 'public'
as $function$
  select role from employees where user_id = auth.uid() and deactivated_at is null;
$function$;

-- New: lets an owner deactivate/reactivate employees in their own company.
-- No UPDATE policy on employees existed before this -- RLS was enabled with
-- only employees_select_company, so this table was update-deny-all for
-- everyone (owner included) until now. Scoped to company + owner role, not
-- to a specific column (Postgres RLS is row-level, not column-level) -- an
-- owner can update any field on their own company's employees this way, not
-- just deactivated_at. Same trust level owners already have elsewhere in
-- this schema (e.g. jobs_delete_owner_company is unrestricted-within-company
-- too), so this isn't a new class of trust, just extending it to a table
-- that had none yet.
create policy employees_update_owner_company on public.employees
  for update to authenticated
  using (company_id = get_my_company_id() and get_my_role() = 'owner')
  with check (company_id = get_my_company_id() and get_my_role() = 'owner');

-- Verification queries (run after applying):
--   select column_name from information_schema.columns where table_name = 'employees' and column_name = 'deactivated_at'; -- expect 1 row
--   select conname from pg_constraint where conname = 'employees_company_email_unique'; -- expect 1 row
--   select prosrc from pg_proc where proname = 'get_my_company_id'; -- confirm "and deactivated_at is null" is present
--   select policyname from pg_policies where tablename = 'employees' and policyname = 'employees_update_owner_company'; -- expect 1 row
