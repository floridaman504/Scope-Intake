-- 2026-08-16: Self-service email change (follow-on from the audit-trail
-- item -- Dante flagged that "email changes" had nothing to log because
-- there was no email-change feature at all; this adds the feature itself).
--
-- Depends on 2026-08-16-audit-trail.sql (employees_audit_log_trigger and
-- the audit_log table) also being applied for the logging half of this to
-- take effect. Order doesn't matter for THIS file to apply cleanly either
-- way -- create or replace is safe to run before or after the trigger
-- bindings exist -- but the 'email_changed' log entries won't actually
-- appear until both are live.
--
-- WHY TWO STEPS (Supabase-side confirm, then this sync), not one: Supabase
-- Auth owns auth.users.email, not this app's schema -- same reason
-- password resets needed a narrow RPC instead of a trigger
-- (docs/migrations/2026-08-16-audit-trail.sql). supabase.auth.updateUser({
-- email }) on the client only REQUESTS the change; Supabase sends a
-- confirmation link and auth.users.email doesn't actually change until
-- that's clicked. This app's own employees.email column (used everywhere
-- in the UI -- Team page, job assignment, etc.) has no way to know that
-- happened on its own, so sync_my_email() is the second half: called from
-- the confirmation-landing page (src/EmailChangeConfirmed.jsx) once
-- Supabase's own change is confirmed, it copies the now-confirmed
-- auth.users.email onto the caller's own employees row.
--
-- sync_my_email() takes NO parameters on purpose -- it re-reads the
-- caller's own already-verified email from auth.users rather than trusting
-- anything the client sends, so this can't be used to set employees.email
-- to an arbitrary, unconfirmed value. It can only ever pull in what
-- Supabase Auth itself has already confirmed for that exact signed-in user.

create or replace function public.sync_my_email()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_auth_email text;
begin
  select email into v_auth_email from auth.users where id = auth.uid();
  if v_auth_email is null then
    return;
  end if;

  update employees
  set email = v_auth_email
  where user_id = auth.uid()
    and deactivated_at is null
    and email is distinct from v_auth_email;
end;
$function$;

grant execute on function public.sync_my_email() to authenticated;

-- Extends employees_audit_log_trigger (originally defined in
-- 2026-08-16-audit-trail.sql) to also log an email change -- full
-- re-declaration since create or replace needs the whole function body,
-- not a diff. The INSERT/deactivation/role branches below are unchanged
-- from that file; only the new "email" check under TG_OP = 'UPDATE' is new.
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
    if NEW.email is distinct from OLD.email then
      insert into audit_log (company_id, action, actor_employee_id, actor_label, ip_address, target_table, target_id, target_label, details)
      values (
        NEW.company_id, 'employee_email_changed', v_actor.id, coalesce(v_actor.full_name, v_actor.email), v_ip,
        'employees', NEW.id, coalesce(NEW.full_name, NEW.email),
        jsonb_build_object('old_email', OLD.email, 'new_email', NEW.email)
      );
    end if;
    return NEW;
  end if;

  return NEW;
end;
$function$;

-- Verification queries (run after applying):
--   select proname from pg_proc where proname = 'sync_my_email'; -- expect 1 row
--   select has_function_privilege('authenticated', 'sync_my_email()', 'execute'); -- expect true
--   -- functional (needs 2026-08-16-audit-trail.sql applied too): as a
--   -- signed-in employee whose auth.users.email was just confirmed-changed
--   -- by Supabase, call select sync_my_email(); then
--   -- select email from employees where user_id = auth.uid(); -- expect
--   -- the new email, and one new audit_log row with
--   -- action = 'employee_email_changed'.
