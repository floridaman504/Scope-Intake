-- Tier 1.3: session/auth hardening
--
-- APPLIED TO PRODUCTION (etpzprrroxjjroisboui). Confirmed live and verified
-- 2026-08-13: session_policy and user_sessions tables exist, RLS enabled on
-- both, all four functions (register_session, touch_session, revoke_session,
-- sign_out_everywhere) present, user_sessions is in the supabase_realtime
-- publication. At verification time user_sessions already held 25 real rows
-- across 4 distinct users with the earliest dated 2026-08-09 -- meaning this
-- was actually applied and collecting real session data days before this
-- comment was corrected; the "NOT YET APPLIED" language below was stale.
-- Re-running this file is safe (every statement is idempotent -- create
-- table/policy/function if-not-exists or drop-then-create), so it can still
-- be used to reconcile a fresh environment or confirm state on production.
--
-- Context: Supabase Auth's native per-role session TTL / concurrent-session
-- cap / inactivity timeout ("User Sessions" panel in Auth > Sessions) is
-- gated to the Pro plan and above -- confirmed directly against this
-- project's dashboard on 2026-08-06, which shows "Configuring user
-- sessions is only available on the Pro Plan and above" with those
-- controls disabled. This project is on Free. So this migration builds an
-- app-level session registry that the client consults, layered on top of
-- Supabase's own JWT/refresh-token mechanism (which we don't and can't
-- change the free-tier behavior of). See the audit doc for what this does
-- and doesn't guarantee.
--
-- Depends on get_my_company_id() and get_my_role(), both already live in
-- production (see docs/audits/2026-08-06-cross-tenant-isolation-audit.md).

-- ============================================================================
-- 1. session_policy -- per-role lifetime + concurrent-session cap, editable
--    by Dante directly in the SQL editor without a code deploy.
-- ============================================================================

create table if not exists session_policy (
    role text primary key,
    max_lifetime_minutes int not null,
    concurrent_session_limit int not null default 3
  );

insert into session_policy (role, max_lifetime_minutes, concurrent_session_limit) values
  ('owner', 120, 3),
  ('dispatcher', 1440, 3),
  ('plumber', 1440, 3)
on conflict (role) do update
  set max_lifetime_minutes = excluded.max_lifetime_minutes,
      concurrent_session_limit = excluded.concurrent_session_limit;

alter table session_policy enable row level security;

-- Every authenticated employee needs to read the policy to compute their
-- own sliding-expiry deadline client-side. No insert/update/delete policy
-- is defined for `authenticated`, so writes only happen via the SQL editor
-- (service_role / table owner bypasses RLS) -- intentional, keeps this a
-- Dante-only knob.
-- (drop-then-create, not "create policy if not exists" -- Postgres doesn't
-- support that syntax -- so this whole file can be safely re-run.)
drop policy if exists "session_policy_select_authenticated" on session_policy;
create policy "session_policy_select_authenticated"
on session_policy for select
to authenticated
using (true);


-- ============================================================================
-- 2. user_sessions -- one row per registered client session.
-- ============================================================================

create table if not exists user_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    company_id uuid not null,
    role_at_login text not null,
    device_label text,
    user_agent text,
    ip_address text,
    created_at timestamptz not null default now(),
    last_activity_at timestamptz not null default now(),
    revoked_at timestamptz,
    revoked_reason text
  );

create index if not exists user_sessions_user_id_idx on user_sessions(user_id);
create index if not exists user_sessions_company_id_idx on user_sessions(company_id);
create index if not exists user_sessions_active_idx on user_sessions(user_id) where revoked_at is null;

alter table user_sessions enable row level security;

-- Users can see their own session rows (for a self-service "your other
-- devices" view, not just Owner's registry).
drop policy if exists "user_sessions_select_own" on user_sessions;
create policy "user_sessions_select_own"
on user_sessions for select
to authenticated
using (user_id = auth.uid());

-- Owners can see every session row for employees in their own company.
drop policy if exists "user_sessions_select_owner_company" on user_sessions;
create policy "user_sessions_select_owner_company"
on user_sessions for select
to authenticated
using (company_id = get_my_company_id() and get_my_role() = 'owner');

-- No direct insert/update/delete policies for `authenticated` -- all
-- writes go through the SECURITY DEFINER functions below, so every write
-- is validated server-side (correct company_id, correct role, cap
-- enforcement, revocation authorization) instead of trusting client input.


-- ============================================================================
-- 3. register_session() -- called once per login. Enforces the concurrent
--    session cap by revoking the oldest excess active sessions.
-- ============================================================================

create or replace function register_session(p_device_label text, p_user_agent text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
  v_limit int;
  v_session_id uuid;
  v_ip text;
begin
  v_company_id := get_my_company_id();
  v_role := get_my_role();

  if v_company_id is null or v_role is null then
    raise exception 'No employee record for this user; cannot register a session';
  end if;

  select concurrent_session_limit into v_limit
  from session_policy where role = v_role;
  if v_limit is null then
    v_limit := 3; -- fallback if a future role is added and the policy table isn't updated yet
  end if;

  -- Best-effort IP capture. PostgREST forwards the request's headers via
  -- current_setting('request.headers'), which includes x-forwarded-for
  -- when present. This reflects what reached Supabase's edge, which is
  -- usually the real client IP but can be a proxy/CDN hop in some
  -- configurations -- treat it as informational, not an audit-grade IP log.
  begin
    v_ip := (current_setting('request.headers', true)::json ->> 'x-forwarded-for');
  exception when others then
    v_ip := null;
  end;

  insert into user_sessions (user_id, company_id, role_at_login, device_label, user_agent, ip_address)
  values (auth.uid(), v_company_id, v_role, p_device_label, p_user_agent, v_ip)
  returning id into v_session_id;

  -- Enforce the cap: revoke the oldest active sessions beyond the limit,
  -- keeping the newest v_limit (including the one just inserted).
  update user_sessions
  set revoked_at = now(), revoked_reason = 'concurrent_session_limit_exceeded'
  where id in (
        select id from user_sessions
        where user_id = auth.uid() and revoked_at is null
        order by last_activity_at desc
        offset v_limit
      );

  return v_session_id;
end;
$$;
grant execute on function register_session(text, text) to authenticated;


-- ============================================================================
-- 4. touch_session() -- called on real user activity (throttled client-
--    side). Updates last_activity_at and returns whether the session is
--    still valid so the client can self-check without a second round trip.
-- ============================================================================

create or replace function touch_session(p_session_id uuid)
returns table(valid boolean, revoked boolean, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_limit_minutes int;
  v_revoked_at timestamptz;
  v_last_activity timestamptz;
begin
  select role_at_login, revoked_at, last_activity_at
  into v_role, v_revoked_at, v_last_activity
  from user_sessions
  where id = p_session_id and user_id = auth.uid();

  if not found then
    return query select false, true, null::timestamptz;
    return;
  end if;

  if v_revoked_at is not null then
    return query select false, true, null::timestamptz;
    return;
  end if;

  select max_lifetime_minutes into v_limit_minutes
  from session_policy where role = v_role;
  if v_limit_minutes is null then
    v_limit_minutes := 1440;
  end if;

  -- Sliding window: server-side expiry check against the CURRENT
  -- last_activity_at, before we bump it, so a session that's already past
  -- its inactivity deadline can't extend itself by touching in.
  if v_last_activity + (v_limit_minutes || ' minutes')::interval < now() then
    update user_sessions
    set revoked_at = now(), revoked_reason = 'inactivity_timeout'
    where id = p_session_id;
    return query select false, false, null::timestamptz;
    return;
  end if;

  update user_sessions
  set last_activity_at = now()
  where id = p_session_id;

  return query select true, false, (now() + (v_limit_minutes || ' minutes')::interval);
end;
$$;
grant execute on function touch_session(uuid) to authenticated;


-- ============================================================================
-- 5. revoke_session() -- single-session revoke, for the Owner registry UI's
--    per-row "revoke" button.
-- ============================================================================

create or replace function revoke_session(p_session_id uuid, p_reason text default 'manual_revoke')
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_user uuid;
  v_target_company uuid;
begin
  select user_id, company_id into v_target_user, v_target_company
  from user_sessions where id = p_session_id;

  if not found then
    return false;
  end if;

  if v_target_user <> auth.uid()
     and not (v_target_company = get_my_company_id() and get_my_role() = 'owner') then
    raise exception 'Not authorized to revoke this session';
  end if;

  update user_sessions
  set revoked_at = now(), revoked_reason = p_reason
  where id = p_session_id and revoked_at is null;

  return true;
end;
$$;
grant execute on function revoke_session(uuid, text) to authenticated;


-- ============================================================================
-- 6. sign_out_everywhere() -- the "revocation endpoint" from the playbook.
--    Self-callable by anyone (e.g. after a password change). Owner-callable
--    against any employee in their own company (e.g. suspicious-activity
--    flag or manual admin action).
-- ============================================================================

create or replace function sign_out_everywhere(p_target_user_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
  v_target_company uuid;
  v_count int;
begin
  if p_target_user_id is null or p_target_user_id = auth.uid() then
    v_target := auth.uid();
  else
    select company_id into v_target_company
    from employees where user_id = p_target_user_id;

    if v_target_company is null or v_target_company <> get_my_company_id() or get_my_role() <> 'owner' then
      raise exception 'Not authorized to sign out this user';
    end if;
    v_target := p_target_user_id;
  end if;

  update user_sessions
  set revoked_at = now(), revoked_reason = coalesce(revoked_reason, 'sign_out_everywhere')
  where user_id = v_target and revoked_at is null;
  get diagnostics v_count = row_count;

  return v_count;
end;
$$;
grant execute on function sign_out_everywhere(uuid) to authenticated;


-- ============================================================================
-- 7. Realtime -- lets the client subscribe to its own user_sessions row and
--    hear about revocation (Owner clicked "revoke", or sign_out_everywhere
--    ran elsewhere) within seconds instead of waiting for the next poll.
--    Free tier includes Realtime (200 concurrent connections / 2M msgs a
--    month at time of writing), so this costs nothing extra. RLS already
--    restricts what a subscriber can see (own rows, or company rows if
--    Owner), and Realtime respects the same RLS policies as normal reads.
-- ============================================================================

do $$
begin
  if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_sessions'
    ) then
    alter publication supabase_realtime add table user_sessions;
  end if;
end $$;


-- ============================================================================
-- Notes / things intentionally NOT done here:
--
-- - This does not and cannot make an already-issued JWT (access token)
--   invalid before its own expiry. touch_session()/the realtime channel
--   only stop the app from ACTING on a revoked/expired session -- a raw
--   captured access token could still pass Supabase's own JWT signature
--   check against PostgREST/RLS for up to the access-token-expiry window
--   configured in Auth > Sessions (currently 3600s / 1 hour on this
--   project, confirmed in the dashboard). Shortening that value tightens
--   the residual window; see the audit doc for the recommended value and
--   why it's a separate Dante decision (more frequent refreshes = more
--   auth server load, and it's a global setting, not per-role).
-- - Native "Time-box user sessions" / "Inactivity timeout" / "Single
--   session per user" toggles in Auth > Sessions are Pro-plan-gated on
--   this project as of 2026-08-06 -- not used here, everything above is
--   built to work without them.
-- ============================================================================
