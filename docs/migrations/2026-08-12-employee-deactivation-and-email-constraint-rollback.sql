-- Rollback for 2026-08-12-employee-deactivation-and-email-constraint.sql
--
-- Apply the job-media storage bucket rollback FIRST if that migration was
-- also applied -- its SELECT policy depends on employees.deactivated_at,
-- which this file removes.

drop policy if exists employees_update_owner_company on public.employees;

create or replace function public.get_my_role()
returns text
language sql stable security definer
set search_path to 'public'
as $function$
  select role from employees where user_id = auth.uid();
$function$;

create or replace function public.get_my_company_id()
returns uuid
language sql stable security definer
set search_path to 'public'
as $function$
  select company_id from employees where user_id = auth.uid();
$function$;

alter table employees drop constraint if exists employees_company_email_unique;
alter table employees drop column if exists deactivated_at;
