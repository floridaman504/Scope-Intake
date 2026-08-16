-- Rollback for 2026-08-16-employee-email-change.sql
--
-- Reverts employees_audit_log_trigger() to the version defined in
-- 2026-08-16-audit-trail.sql (drops the email-changed branch only -- the
-- INSERT/deactivation/role branches are restored exactly as they were
-- there), then drops sync_my_email() entirely.
--
-- NOTE: only run this if 2026-08-16-audit-trail.sql's own trigger function
-- is still in place (i.e. that migration hasn't also been rolled back). If
-- both are being rolled back together, run this file first, then that
-- file's own rollback (which drops the trigger bindings and function for
-- good).

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

drop function if exists public.sync_my_email();

-- Verification queries (run after applying):
--   select proname from pg_proc where proname = 'sync_my_email'; -- expect 0 rows
--   -- trigger still fires for role/deactivation changes but no longer logs
--   -- employee_email_changed (confirm by updating an employees.email value
--   -- and checking no new audit_log row with that action appears).
