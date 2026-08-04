-- Fixes a bug in redeem_invite_code() that broke every invite redemption:
-- invite_codes.used_by is a foreign key to employees(id) -- the employee
-- row's own generated primary key -- but the function was writing
-- auth.uid() into it instead. auth.uid() is stored in employees.user_id,
-- a different column entirely, so it never matched an employees.id value
-- and every redemption failed with:
--   insert or update on table "invite_codes" violates foreign key
--   constraint "invite_codes_used_by_fkey"
--
-- This has already been applied directly against production (2026-08-03)
-- to unblock signup. This file exists so the fix is checked into source
-- control and reproducible on any other environment.

create or replace function redeem_invite_code(
  invite_code text,
  employee_full_name text,
  employee_email text
)
returns employees
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invite_codes%rowtype;
  v_employee employees%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_invite
  from invite_codes
  where code = invite_code
  for update;

  if v_invite is null then
    raise exception 'Invalid invite code';
  end if;

  if v_invite.used_at is not null then
    raise exception 'Invite code already used';
  end if;

  if exists (select 1 from employees where user_id = auth.uid()) then
    raise exception 'This account already has a role assigned';
  end if;

  insert into employees (user_id, email, full_name, role, company_id)
  values (auth.uid(), employee_email, employee_full_name, v_invite.role, v_invite.company_id)
  returning * into v_employee;

  -- used_by references employees(id), which is the row's own generated
  -- primary key -- NOT auth.uid() (that's employees.user_id, a different
  -- column). Using auth.uid() here violated invite_codes_used_by_fkey
  -- because that value never exists as a row in employees.id.
  update invite_codes
  set used_at = now(), used_by = v_employee.id
  where id = v_invite.id;

  return v_employee;
end;
$$;

grant execute on function redeem_invite_code(text, text, text) to authenticated;
