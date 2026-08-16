-- 2026-08-16: Sensitive-action audit trail (Tier 2 #9.5 of
-- docs/scope-operational-playbook.md: "for every action that modifies
-- permissions, billing, email, password, or deletes data, log who/when/from
-- what IP/what changed").
--
-- SCOPE DECISION, called out explicitly rather than silently assumed: the
-- playbook lists "permissions, billing, email, password, deletes" as the
-- categories. Checked what actually exists in this codebase today for each:
--   - permissions (role) -- role is set exactly once today, at signup, via
--     redeem_invite_code() inserting a new employees row. There is no
--     in-place "change someone's role" UI or RPC anywhere in this app yet.
--     This migration logs BOTH the initial assignment (action
--     'employee_role_assigned', fires on employees INSERT) and a true
--     in-place change (action 'employee_role_changed', fires on employees
--     UPDATE where role differs) -- the second case is future-proofing for
--     when a role-edit UI gets built; today only the first ever fires.
--     Deactivation/reactivation (an access-permission change even though
--     `role` itself doesn't move) is covered too, as its own action.
--   - billing -- no billing-changing action exists anywhere in this app
--     (companies.plan is never written by any code path today). Nothing to
--     instrument. Flagged here, not silently skipped.
--   - email -- no "change my email" flow exists anywhere in this app today
--     (employees.email is set once at signup, same as role). Nothing to
--     instrument. Flagged here, not silently skipped.
--   - password -- covered: log_password_reset(), called from
--     AuthContext.jsx's changePasswordAndSignOutEverywhere right after
--     Supabase confirms the password itself was changed.
--   - deletes data -- covered: job deletion (the only hard-delete anywhere
--     in this app; employees/invite_codes/etc. are never hard-deleted).
--
-- WHO WRITES TO audit_log, and why triggers over app-level inserts: this
-- codebase's established pattern is to enforce things at the database layer
-- wherever possible (get_my_company_id/get_my_role gating every RLS policy,
-- jobs_before_update_duration_scope_lock blocking a raw client update,
-- etc.) rather than trust the client to always call the "right" code path.
-- Same reasoning here: an AFTER trigger on employees/jobs fires no matter
-- how the row changed (the app's own UI, a future admin tool, a raw
-- supabase-js call bypassing this app's UI entirely) -- there's no way to
-- deactivate an employee or delete a job without an audit_log row being
-- written, short of a direct database superuser session. The one exception
-- is password_reset, which has no table write in THIS schema to hook a
-- trigger onto (Supabase Auth owns auth.users) -- that one is a narrow,
-- single-purpose RPC instead (see log_password_reset() below), scoped so
-- it can only ever write a 'password_reset' row attributed to whoever is
-- calling it, for themselves -- it cannot be used to log anything else or
-- to write an entry impersonating someone else.
--
-- IP capture reuses the exact pattern already proven in
-- supabase_session_hardening.sql's register_session() -- PostgREST forwards
-- the request's headers via current_setting('request.headers'), which
-- includes x-forwarded-for when present. Same honest caveat as that
-- function: best-effort/informational, not an audit-grade IP log, and
-- silently null if the setting isn't present (e.g. a direct psql session).

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  action text not null,
  actor_employee_id uuid references public.employees(id),
  actor_label text,
  ip_address text,
  target_table text not null,
  target_id uuid,
  target_label text,
  details jsonb,
  created_at timestamptz not null default now()
);

comment on table public.audit_log is
  'Sensitive-action audit trail (Tier 2 #9.5). Written to ONLY by the SECURITY DEFINER trigger functions/RPCs below -- never directly by app code -- so a client can''t forge, edit, or delete an entry. Owner-only read, scoped to their own company.';

create index audit_log_company_created_idx on public.audit_log (company_id, created_at desc);

alter table public.audit_log enable row level security;

create policy audit_log_select_owner_company on public.audit_log
  for select to authenticated
  using (company_id = get_my_company_id() and get_my_role() = 'owner');

-- No insert/update/delete policy for anyone, on purpose -- deny-all, same
-- as every other table in this schema. Writes only ever happen via the
-- SECURITY DEFINER functions below, which bypass RLS the same way
-- set_job_duration/redeem_invite_code/etc. already do.

grant select on public.audit_log to authenticated;
-- No insert/update/delete grant to anon or authenticated, matching the
-- minimal-privilege scheme from the cross-tenant audit
-- (2026-08-13-tighten-table-grants.sql) -- only the table owner (which
-- SECURITY DEFINER functions run as) can write here.

-- ---------------------------------------------------------------------------
-- employees: role assignment/change + deactivate/reactivate
-- ---------------------------------------------------------------------------
create or replace function public.employees_audit_log_trigger()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor record;
  v_ip text;
begin
  select id, full_name, email into v_actor
  from employees where user_id = auth.uid() and deactivated_at is null;

  begin
    v_ip := (current_setting('request.headers', true)::json ->> 'x-forwarded-for');
  exception when others then
    v_ip := null;
  end;

  if TG_OP = 'INSERT' then
    insert into audit_log (company_id, action, actor_employee_id, actor_label, ip_address, target_table, target_id, target_label, details)
    values (
      NEW.company_id, 'employee_role_assigned', v_actor.id, coalesce(v_actor.full_name, v_actor.email), v_ip,
      'employees', NEW.id, coalesce(NEW.full_name, NEW.email),
      jsonb_build_object('role', NEW.role)
    );
    return NEW;
  end if;

  if TG_OP = 'UPDATE' then
    if NEW.deactivated_at is distinct from OLD.deactivated_at then
      insert into audit_log (company_id, action, actor_employee_id, actor_label, ip_address, target_table, target_id, target_label, details)
      values (
        NEW.company_id,
        case when NEW.deactivated_at is null then 'employee_reactivated' else 'employee_deactivated' end,
        v_actor.id, coalesce(v_actor.full_name, v_actor.email), v_ip,
        'employees', NEW.id, coalesce(NEW.full_name, NEW.email),
        jsonb_build_object('deactivated_at', NEW.deactivated_at)
      );
    end if;
    if NEW.role is distinct from OLD.role then
      insert into audit_log (company_id, action, actor_employee_id, actor_label, ip_address, target_table, target_id, target_label, details)
      values (
        NEW.company_id, 'employee_role_changed', v_actor.id, coalesce(v_actor.full_name, v_actor.email), v_ip,
        'employees', NEW.id, coalesce(NEW.full_name, NEW.email),
        jsonb_build_object('old_role', OLD.role, 'new_role', NEW.role)
      );
    end if;
    return NEW;
  end if;

  return NEW;
end;
$function$;

create trigger employees_audit_log_after_insert
  after insert on public.employees
  for each row execute function public.employees_audit_log_trigger();

create trigger employees_audit_log_after_update
  after update on public.employees
  for each row execute function public.employees_audit_log_trigger();

-- ---------------------------------------------------------------------------
-- jobs: deletion
-- ---------------------------------------------------------------------------
create or replace function public.jobs_audit_log_after_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor record;
  v_ip text;
begin
  select id, full_name, email into v_actor
  from employees where user_id = auth.uid() and deactivated_at is null;

  begin
    v_ip := (current_setting('request.headers', true)::json ->> 'x-forwarded-for');
  exception when others then
    v_ip := null;
  end;

  insert into audit_log (company_id, action, actor_employee_id, actor_label, ip_address, target_table, target_id, target_label, details)
  values (
    OLD.company_id, 'job_deleted', v_actor.id, coalesce(v_actor.full_name, v_actor.email), v_ip,
    'jobs', OLD.id, coalesce(OLD.customer_name, OLD.ai_job_type, 'Unnamed job'),
    jsonb_build_object('status', OLD.status, 'customer_name', OLD.customer_name)
  );
  return OLD;
end;
$function$;

create trigger jobs_audit_log_after_delete_trigger
  after delete on public.jobs
  for each row execute function public.jobs_audit_log_after_delete();

-- ---------------------------------------------------------------------------
-- password resets (no table this app owns to hook a trigger onto --
-- Supabase Auth owns auth.users -- so this is a narrow, single-purpose RPC
-- instead, called from AuthContext.jsx right after Supabase confirms the
-- password itself was changed)
-- ---------------------------------------------------------------------------
create or replace function public.log_password_reset()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor record;
  v_ip text;
begin
  select id, company_id, full_name, email into v_actor
  from employees where user_id = auth.uid() and deactivated_at is null;

  if v_actor.id is null then
    -- Caller isn't a recognized, active employee (e.g. account exists in
    -- auth.users but never redeemed an invite). Nothing to attribute this
    -- to -- skip rather than fail the password reset itself over a missing
    -- log entry.
    return;
  end if;

  begin
    v_ip := (current_setting('request.headers', true)::json ->> 'x-forwarded-for');
  exception when others then
    v_ip := null;
  end;

  insert into audit_log (company_id, action, actor_employee_id, actor_label, ip_address, target_table, target_id, target_label)
  values (v_actor.company_id, 'password_reset', v_actor.id, coalesce(v_actor.full_name, v_actor.email), v_ip, 'auth.users', v_actor.id, coalesce(v_actor.full_name, v_actor.email));
end;
$function$;

grant execute on function public.log_password_reset() to authenticated;

-- Verification queries (run after applying):
--   select to_regclass('public.audit_log'); -- expect 'audit_log', not null
--   select tgname from pg_trigger where tgname in
--     ('employees_audit_log_after_insert', 'employees_audit_log_after_update', 'jobs_audit_log_after_delete_trigger'); -- expect 3 rows
--   select proname from pg_proc where proname = 'log_password_reset'; -- expect 1 row
--   select policyname from pg_policies where tablename = 'audit_log'; -- expect audit_log_select_owner_company
--   select has_table_privilege('anon', 'audit_log', 'select'); -- expect false
--   select has_table_privilege('authenticated', 'audit_log', 'select'); -- expect true
--   -- functional: deactivate a test employee, delete a test job, and (as
--   -- that employee) call log_password_reset() -- confirm 3 new audit_log
--   -- rows with the right action/actor/target.
