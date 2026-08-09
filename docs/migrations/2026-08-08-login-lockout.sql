-- Migration: login lockout (Tier 1.5 login test suite -- account lockout
-- after 5 failed attempts)
-- Date: 2026-08-08
-- Author: Dante (via Claude)
--
-- Expand-contract stage: Expand only. Adds one new table and three new
-- functions. Touches nothing that exists today -- old app code that
-- doesn't call these functions keeps working exactly as before.
--
-- WHAT THIS DOES
-- A new `login_attempts` table tracks failed sign-in attempts per email.
-- Three SECURITY DEFINER functions are the only way to touch it:
--   check_login_allowed(email)   -- called BEFORE attempting sign-in
--   record_failed_login(email)   -- called AFTER a failed sign-in
--   clear_login_attempts(email)  -- called AFTER a successful sign-in
-- After 5 failed attempts inside a 15-minute window, further attempts for
-- that email are blocked for 15 minutes (rolling: each new failed attempt
-- while locked extends nothing further, it just stays locked until
-- locked_until passes).
--
-- IMPORTANT, HONEST LIMITATION (not glossed over): these functions accept
-- a plain email string and are callable by anyone, including someone not
-- signed in (anon role) -- they have to be, since login lockout has to
-- work BEFORE a user is authenticated. That means someone could call
-- record_failed_login() with a real customer's email 5 times, with zero
-- knowledge of their password, and lock that person out for 15 minutes.
-- That's a real tradeoff of email-only lockout (most consumer apps that do
-- this have the same exposure). Fixing it properly means tracking by IP as
-- well as email, which needs the PostgREST request-header plumbing and is
-- really a Tier 2 rate-limiting concern (item #11 in the playbook) rather
-- than something to solve inside this one migration. Shipping this now
-- still meaningfully raises the bar over today (zero lockout of any kind)
-- against casual/naive password-guessing, which is the realistic threat
-- level right now.
--
-- HOW TO VERIFY IT WORKED
-- select * from login_attempts; -- should exist, empty
-- select * from check_login_allowed('nobody@example.com');
--   -> should return one row: allowed=true, locked_until=null
-- select record_failed_login('nobody@example.com'); -- call 5x
-- select * from check_login_allowed('nobody@example.com');
--   -> after the 5th call, allowed=false, locked_until set ~15 min out
-- select clear_login_attempts('nobody@example.com');
-- select * from check_login_allowed('nobody@example.com');
--   -> back to allowed=true

-- ============================== FORWARD ====================================

create table if not exists public.login_attempts (
  email text primary key,
  failed_count int not null default 0,
  first_failed_at timestamptz,
  locked_until timestamptz
);

-- RLS enabled with ZERO policies -- same pattern as `companies`: nobody
-- (anon or authenticated) can read or write this table directly. The only
-- access path is through the three SECURITY DEFINER functions below.
alter table public.login_attempts enable row level security;

create or replace function public.check_login_allowed(p_email text)
returns table(allowed boolean, locked_until timestamptz)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_row public.login_attempts%rowtype;
  v_email text := lower(trim(p_email));
begin
  select * into v_row from public.login_attempts where email = v_email;

  if v_row is null then
    return query select true, null::timestamptz;
    return;
  end if;

  if v_row.locked_until is not null and v_row.locked_until > now() then
    return query select false, v_row.locked_until;
    return;
  end if;

  return query select true, null::timestamptz;
end;
$$;

create or replace function public.record_failed_login(p_email text)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_row public.login_attempts%rowtype;
  v_email text := lower(trim(p_email));
  v_window interval := interval '15 minutes';
  v_lockout_duration interval := interval '15 minutes';
  v_max_attempts int := 5;
begin
  select * into v_row from public.login_attempts where email = v_email for update;

  if v_row is null then
    insert into public.login_attempts (email, failed_count, first_failed_at, locked_until)
    values (v_email, 1, now(), null);
    return;
  end if;

  -- Outside the window since the first failure in this streak -- start a
  -- fresh count instead of accumulating forever.
  if v_row.first_failed_at is null or now() - v_row.first_failed_at > v_window then
    update public.login_attempts
      set failed_count = 1, first_failed_at = now(), locked_until = null
      where email = v_email;
    return;
  end if;

  update public.login_attempts
    set failed_count = v_row.failed_count + 1,
        locked_until = case
          when v_row.failed_count + 1 >= v_max_attempts then now() + v_lockout_duration
          else v_row.locked_until
        end
    where email = v_email;
end;
$$;

create or replace function public.clear_login_attempts(p_email text)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  delete from public.login_attempts where email = lower(trim(p_email));
end;
$$;

-- ============================== ROLLBACK ===================================
-- Exact inverse of everything above. Run this to fully undo the migration.

-- drop function if exists public.clear_login_attempts(text);
-- drop function if exists public.record_failed_login(text);
-- drop function if exists public.check_login_allowed(text);
-- drop table if exists public.login_attempts;
