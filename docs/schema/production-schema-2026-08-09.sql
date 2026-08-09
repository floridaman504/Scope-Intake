-- =============================================================================
-- Scope Intake — Production Schema Snapshot
-- Generated: 2026-08-09
-- Source: Supabase project "scope" (etpzprrroxjjroisboui), schema `public`
-- Method: live introspection via information_schema / pg_catalog, run directly
--         against production through the Supabase SQL Editor (no CLI/pg_dump
--         access was available from the automation environment used to
--         generate this file — network egress to *.supabase.co is blocked
--         there). This is a faithful, complete snapshot of columns,
--         constraints, indexes, RLS policies, grants, functions and triggers
--         as they exist in production at the time above.
--
-- NOT a literal `pg_dump` file — do not pipe this straight into `psql` to
-- restore a database. It's a documented, human- and diff-readable reference
-- for disaster recovery and code review. If a real point-in-time restore is
-- ever needed, use the daily Supabase backups (see
-- .github/workflows/supabase-backup.yml) plus this file to sanity-check that
-- the restored schema matches what production actually had.
--
-- Regenerate periodically (or after any migration) by re-running the
-- introspection query recorded at the bottom of this file.
-- =============================================================================


-- =============================================================================
-- EXTENSIONS
-- =============================================================================
-- pg_stat_statements 1.11, pgcrypto 1.3, plpgsql 1.0, supabase_vault 0.3.1, uuid-ossp 1.1


-- =============================================================================
-- TABLES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- companies  (tenant root — every other table hangs off company_id)
-- ---------------------------------------------------------------------------
CREATE TABLE public.companies (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  subdomain      text NOT NULL,
  custom_domain  text,
  plan           text NOT NULL DEFAULT 'standard'::text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_pkey PRIMARY KEY (id),
  CONSTRAINT companies_subdomain_key UNIQUE (subdomain),
  CONSTRAINT companies_custom_domain_key UNIQUE (custom_domain)
);

-- ---------------------------------------------------------------------------
-- employees  (staff accounts, linked 1:1 to auth.users)
-- ---------------------------------------------------------------------------
CREATE TABLE public.employees (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id     uuid,
  email       text NOT NULL,
  full_name   text,
  role        text NOT NULL,
  created_at  timestamptz DEFAULT now(),
  company_id  uuid NOT NULL,
  CONSTRAINT employees_pkey PRIMARY KEY (id),
  CONSTRAINT employees_user_id_key UNIQUE (user_id),
  CONSTRAINT employees_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT employees_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT employees_role_check CHECK (role = ANY (ARRAY['owner'::text, 'dispatcher'::text, 'plumber'::text]))
);

-- ---------------------------------------------------------------------------
-- invite_codes  (owner-generated onboarding codes for new employees)
-- ---------------------------------------------------------------------------
CREATE TABLE public.invite_codes (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  role        text NOT NULL,
  created_by  uuid,
  used_by     uuid,
  used_at     timestamptz,
  created_at  timestamptz DEFAULT now(),
  company_id  uuid NOT NULL,
  CONSTRAINT invite_codes_pkey PRIMARY KEY (id),
  CONSTRAINT invite_codes_code_key UNIQUE (code),
  CONSTRAINT invite_codes_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT invite_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES employees(id),
  CONSTRAINT invite_codes_used_by_fkey FOREIGN KEY (used_by) REFERENCES employees(id),
  CONSTRAINT invite_codes_role_check CHECK (role = ANY (ARRAY['owner'::text, 'dispatcher'::text, 'plumber'::text]))
);

-- ---------------------------------------------------------------------------
-- jobs  (customer submissions; the core business record)
-- ---------------------------------------------------------------------------
CREATE TABLE public.jobs (
  id                        uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at                timestamptz DEFAULT now(),
  context                   text,
  fixture                   text,
  pipe                      text,
  access                    text,
  cutting                   text,
  preference                text,
  leak_detection            text,
  media_urls                jsonb DEFAULT '[]'::jsonb,
  ai_job_type               text,
  ai_urgency                text,
  ai_materials              jsonb DEFAULT '[]'::jsonb,
  ai_summary                text,
  ai_watch_out              text,
  status                    text DEFAULT 'new'::text,
  company_id                uuid NOT NULL,
  pets                      text,
  customer_name             text,
  customer_phone            text,
  customer_email            text,
  media                     jsonb NOT NULL DEFAULT '[]'::jsonb,
  claimed_by                uuid,
  claimed_at                timestamptz,
  missed_lead_alert_sent_at timestamptz,
  CONSTRAINT jobs_pkey PRIMARY KEY (id),
  CONSTRAINT jobs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT jobs_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES employees(id)
);

-- ---------------------------------------------------------------------------
-- billing_guardrails  (singleton config row, id always = 1)
-- ---------------------------------------------------------------------------
CREATE TABLE public.billing_guardrails (
  id                        integer NOT NULL DEFAULT 1,
  input_price_per_million   numeric NOT NULL DEFAULT 2.00,
  output_price_per_million  numeric NOT NULL DEFAULT 10.00,
  daily_global_cost_cap_usd numeric NOT NULL DEFAULT 10.00,
  per_ip_hourly_limit       integer NOT NULL DEFAULT 8,
  per_company_daily_limit   integer NOT NULL DEFAULT 150,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_guardrails_pkey PRIMARY KEY (id),
  CONSTRAINT billing_guardrails_single_row CHECK (id = 1)
);

-- ---------------------------------------------------------------------------
-- ai_usage_log  (every AI review-endpoint call, for cost tracking + rate limiting)
-- ---------------------------------------------------------------------------
CREATE TABLE public.ai_usage_log (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id          uuid,
  subdomain           text,
  ip_address          text,
  input_tokens        integer NOT NULL DEFAULT 0,
  output_tokens       integer NOT NULL DEFAULT 0,
  estimated_cost_usd  numeric NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_log_pkey PRIMARY KEY (id),
  CONSTRAINT ai_usage_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id)
);

-- ---------------------------------------------------------------------------
-- login_attempts  (lockout tracking, keyed by email)
-- ---------------------------------------------------------------------------
CREATE TABLE public.login_attempts (
  email            text NOT NULL,
  failed_count     integer NOT NULL DEFAULT 0,
  first_failed_at  timestamptz,
  locked_until     timestamptz,
  CONSTRAINT login_attempts_pkey PRIMARY KEY (email)
);

-- ---------------------------------------------------------------------------
-- session_policy  (per-role session lifetime / concurrency rules)
-- ---------------------------------------------------------------------------
CREATE TABLE public.session_policy (
  role                       text NOT NULL,
  max_lifetime_minutes       integer NOT NULL,
  concurrent_session_limit   integer NOT NULL DEFAULT 3,
  CONSTRAINT session_policy_pkey PRIMARY KEY (role)
);

-- ---------------------------------------------------------------------------
-- user_sessions  (active/revoked session registry)
-- ---------------------------------------------------------------------------
CREATE TABLE public.user_sessions (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  company_id         uuid NOT NULL,
  role_at_login      text NOT NULL,
  device_label       text,
  user_agent         text,
  ip_address         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_activity_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  revoked_reason     text,
  CONSTRAINT user_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);


-- =============================================================================
-- INDEXES  (beyond those implied by PRIMARY KEY / UNIQUE constraints above)
-- =============================================================================
CREATE INDEX idx_ai_usage_log_company_created ON public.ai_usage_log USING btree (company_id, created_at);
CREATE INDEX idx_ai_usage_log_ip_created ON public.ai_usage_log USING btree (ip_address, created_at);
CREATE INDEX idx_jobs_unclaimed_created_at ON public.jobs USING btree (created_at) WHERE (claimed_at IS NULL);
CREATE INDEX user_sessions_active_idx ON public.user_sessions USING btree (user_id) WHERE (revoked_at IS NULL);
CREATE INDEX user_sessions_company_id_idx ON public.user_sessions USING btree (company_id);
CREATE INDEX user_sessions_user_id_idx ON public.user_sessions USING btree (user_id);


-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
-- RLS is ENABLED (not FORCEd) on all 9 public tables:
--   ai_usage_log, billing_guardrails, companies, employees, invite_codes,
--   jobs, login_attempts, session_policy, user_sessions
-- "Not FORCEd" means the table owner (and any role with BYPASSRLS, e.g.
-- postgres/service_role) still bypasses these policies -- expected/normal
-- for Supabase; only anon/authenticated are actually constrained by them.

ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_guardrails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

-- Policies actually defined (11 total). Every one of these is scoped through
-- get_my_company_id() / get_my_role() -- both SECURITY DEFINER functions
-- that look up the caller's own employee row via auth.uid(), so a logged-in
-- user can only ever see/act on data via helper functions that key off
-- their own row, not an arbitrary company_id they could pass in.

CREATE POLICY ai_usage_select_company ON public.ai_usage_log
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());

CREATE POLICY employees_select_company ON public.employees
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());

CREATE POLICY owners_create_own_company_invite_codes ON public.invite_codes
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id() AND get_my_role() = 'owner'::text);

CREATE POLICY owners_select_own_company_invite_codes ON public.invite_codes
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id() AND get_my_role() = 'owner'::text);

CREATE POLICY jobs_delete_owner_company ON public.jobs
  FOR DELETE TO authenticated
  USING (company_id = get_my_company_id() AND get_my_role() = 'owner'::text);

CREATE POLICY jobs_insert_public ON public.jobs
  FOR INSERT TO anon, authenticated
  WITH CHECK (company_id IS NOT NULL AND company_exists(company_id));

CREATE POLICY jobs_select_company ON public.jobs
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());

CREATE POLICY jobs_update_owner_dispatcher_company ON public.jobs
  FOR UPDATE TO authenticated
  USING (company_id = get_my_company_id() AND get_my_role() = ANY (ARRAY['owner'::text, 'dispatcher'::text]));

CREATE POLICY session_policy_select_authenticated ON public.session_policy
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY user_sessions_select_own ON public.user_sessions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY user_sessions_select_owner_company ON public.user_sessions
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id() AND get_my_role() = 'owner'::text);

-- NOTE (feeds directly into task #22, "tighten overly-broad grants"):
-- companies, billing_guardrails, and login_attempts have RLS ENABLED but
-- ZERO policies defined on them. With no permissive policy, RLS defaults to
-- deny-all for anon/authenticated -- so today they're actually LOCKED DOWN
-- for those roles despite the wide-open GRANTs below. That's accidental
-- safety, not intentional design, and it also means legitimate app code
-- (e.g. get_company_by_subdomain) has to go through SECURITY DEFINER
-- functions to read companies at all, which happens to be exactly what's
-- already done. Don't "fix" this by relaxing RLS on these three tables --
-- if anything, tightening task #22 should also make sure it stays this way
-- on purpose (documented), not by accident.


-- =============================================================================
-- GRANTS  (table-level privileges — see task #22)
-- =============================================================================
-- CURRENT STATE (as introspected): every one of the 9 public tables grants
-- ALL SEVEN privileges (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
-- TRIGGER) to BOTH `anon` and `authenticated`, identically, with no
-- per-table variation. This is Supabase's default and is NOT scoped down.
--
-- Today this is only safe because RLS policies (or the deny-all-by-default
-- effect of RLS-enabled-but-no-policy, see note above) are doing 100% of the
-- real access control. That means a single missing/misconfigured RLS policy
-- on any table is the ONLY thing standing between "anon" and full
-- read/write/delete on that table. This is the exact overly-broad-grants
-- finding from docs/audits/2026-08-06-cross-tenant-isolation-audit.md
-- (task #22, still pending) -- belt-and-suspenders grants should exist
-- alongside RLS, not instead of it.
--
-- Full per-table grant list (identical pattern x9 tables):
--   ai_usage_log, billing_guardrails, companies, employees, invite_codes,
--   jobs, login_attempts, session_policy, user_sessions
--     -> anon:          DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--     -> authenticated: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--     -> service_role:  DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE  (expected/fine, bypasses RLS by design)


-- =============================================================================
-- FUNCTIONS  (all SECURITY DEFINER unless noted; this is the real access-
-- control layer for this schema, more than the grants above)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_my_company_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select company_id from employees where user_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select role from employees where user_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.company_exists(p_company_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select exists(select 1 from public.companies where id = p_company_id);
$function$;

CREATE OR REPLACE FUNCTION public.get_company_by_subdomain(p_subdomain text)
RETURNS TABLE(id uuid, name text, subdomain text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select id, name, subdomain
  from companies
  where subdomain = lower(p_subdomain)
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.submit_public_job(
  p_subdomain text, p_customer_name text, p_customer_phone text, p_customer_email text,
  p_context text, p_fixture text, p_pipe text, p_access text, p_cutting text,
  p_preference text, p_leak_detection text, p_pets text,
  p_ai_job_type text, p_ai_urgency text, p_ai_materials text[], p_ai_summary text, p_ai_watch_out text
)
RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid;
  v_job jobs%rowtype;
begin
  select id into v_company_id from companies where subdomain = lower(p_subdomain) limit 1;
  if v_company_id is null then raise exception 'Unknown company'; end if;
  insert into jobs (company_id, customer_name, customer_phone, customer_email, context, fixture, pipe,
    access, cutting, preference, leak_detection, pets, ai_job_type, ai_urgency, ai_materials,
    ai_summary, ai_watch_out, status)
  values (v_company_id, p_customer_name, p_customer_phone, p_customer_email, p_context, p_fixture,
    p_pipe, p_access, p_cutting, p_preference, p_leak_detection, p_pets, p_ai_job_type, p_ai_urgency,
    to_json(p_ai_materials), p_ai_summary, p_ai_watch_out, 'new')
  returning * into v_job;
  return v_job;
end;
$function$;

CREATE OR REPLACE FUNCTION public.attach_job_media(p_job_id uuid, p_subdomain text, p_media jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare v_company_id uuid;
begin
  select id into v_company_id from companies where subdomain = lower(p_subdomain) limit 1;
  if v_company_id is null then raise exception 'Unknown company'; end if;
  update jobs set media = p_media where id = p_job_id and company_id = v_company_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.redeem_invite_code(invite_code text, employee_full_name text, employee_email text)
RETURNS employees
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_invite invite_codes%rowtype;
  v_employee employees%rowtype;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into v_invite from invite_codes where code = invite_code for update;
  if v_invite is null then raise exception 'Invalid invite code'; end if;
  if v_invite.used_at is not null then raise exception 'Invite code already used'; end if;
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
  update invite_codes set used_at = now(), used_by = v_employee.id where id = v_invite.id;

  return v_employee;
end;
$function$;

CREATE OR REPLACE FUNCTION public.check_rate_limit(p_subdomain text, p_ip text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_guard billing_guardrails%rowtype;
  v_company_id uuid;
  v_ip_count int;
  v_company_count int;
  v_global_cost numeric;
begin
  select * into v_guard from billing_guardrails where id = 1;
  if v_guard is null then return null; end if;

  select count(*) into v_ip_count from ai_usage_log
  where ip_address = p_ip and created_at > now() - interval '1 hour';
  if v_ip_count >= v_guard.per_ip_hourly_limit then return 'rate_limited_ip'; end if;

  select id into v_company_id from companies where subdomain = lower(coalesce(p_subdomain, '')) limit 1;
  if v_company_id is not null then
    select count(*) into v_company_count from ai_usage_log
    where company_id = v_company_id and created_at > now() - interval '24 hours';
    if v_company_count >= v_guard.per_company_daily_limit then return 'rate_limited_company'; end if;
  end if;

  select coalesce(sum(estimated_cost_usd), 0) into v_global_cost from ai_usage_log
  where created_at > now() - interval '24 hours';
  if v_global_cost >= v_guard.daily_global_cost_cap_usd then return 'global_cap_reached'; end if;

  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.log_ai_usage(p_subdomain text, p_ip text, p_input_tokens integer, p_output_tokens integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid;
  v_guard billing_guardrails%rowtype;
  v_cost numeric;
begin
  select id into v_company_id from companies where subdomain = lower(coalesce(p_subdomain, '')) limit 1;
  select * into v_guard from billing_guardrails where id = 1;

  v_cost := (coalesce(p_input_tokens, 0)::numeric / 1000000 * coalesce(v_guard.input_price_per_million, 2.00))
          + (coalesce(p_output_tokens, 0)::numeric / 1000000 * coalesce(v_guard.output_price_per_million, 10.00));

  insert into ai_usage_log (company_id, subdomain, ip_address, input_tokens, output_tokens, estimated_cost_usd)
  values (v_company_id, lower(coalesce(p_subdomain, '')), p_ip, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0), v_cost);
end;
$function$;

CREATE OR REPLACE FUNCTION public.check_login_allowed(p_email text)
RETURNS TABLE(allowed boolean, locked_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_row public.login_attempts%rowtype;
  v_email text := lower(trim(p_email));
begin
  select * into v_row from public.login_attempts where email = v_email;
  if v_row is null then return query select true, null::timestamptz; return; end if;
  if v_row.locked_until is not null and v_row.locked_until > now() then
    return query select false, v_row.locked_until; return;
  end if;
  return query select true, null::timestamptz;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_failed_login(p_email text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  if v_row.first_failed_at is null or now() - v_row.first_failed_at > v_window then
    update public.login_attempts set failed_count = 1, first_failed_at = now(), locked_until = null where email = v_email;
    return;
  end if;
  update public.login_attempts
  set failed_count = v_row.failed_count + 1,
      locked_until = case when v_row.failed_count + 1 >= v_max_attempts then now() + v_lockout_duration else v_row.locked_until end
  where email = v_email;
end;
$function$;

CREATE OR REPLACE FUNCTION public.clear_login_attempts(p_email text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  delete from public.login_attempts where email = lower(trim(p_email));
end;
$function$;

CREATE OR REPLACE FUNCTION public.register_session(p_device_label text, p_user_agent text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  select concurrent_session_limit into v_limit from session_policy where role = v_role;
  if v_limit is null then v_limit := 3; end if;
  begin
    v_ip := (current_setting('request.headers', true)::json ->> 'x-forwarded-for');
  exception when others then v_ip := null;
  end;
  insert into user_sessions (user_id, company_id, role_at_login, device_label, user_agent, ip_address)
  values (auth.uid(), v_company_id, v_role, p_device_label, p_user_agent, v_ip)
  returning id into v_session_id;
  update user_sessions set revoked_at = now(), revoked_reason = 'concurrent_session_limit_exceeded'
  where id in (
    select id from user_sessions
    where user_id = auth.uid() and revoked_at is null
    order by last_activity_at desc offset v_limit
  );
  return v_session_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.touch_session(p_session_id uuid)
RETURNS TABLE(valid boolean, revoked boolean, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_role text;
  v_limit_minutes int;
  v_revoked_at timestamptz;
  v_last_activity timestamptz;
begin
  select role_at_login, revoked_at, last_activity_at into v_role, v_revoked_at, v_last_activity
  from user_sessions where id = p_session_id and user_id = auth.uid();
  if not found then return query select false, true, null::timestamptz; return; end if;
  if v_revoked_at is not null then return query select false, true, null::timestamptz; return; end if;
  select max_lifetime_minutes into v_limit_minutes from session_policy where role = v_role;
  if v_limit_minutes is null then v_limit_minutes := 1440; end if;
  if v_last_activity + (v_limit_minutes || ' minutes')::interval < now() then
    update user_sessions set revoked_at = now(), revoked_reason = 'inactivity_timeout' where id = p_session_id;
    return query select false, false, null::timestamptz;
    return;
  end if;
  update user_sessions set last_activity_at = now() where id = p_session_id;
  return query select true, false, (now() + (v_limit_minutes || ' minutes')::interval);
end;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_session(p_session_id uuid, p_reason text DEFAULT 'manual_revoke'::text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_target_user uuid;
  v_target_company uuid;
begin
  select user_id, company_id into v_target_user, v_target_company from user_sessions where id = p_session_id;
  if not found then return false; end if;
  if v_target_user <> auth.uid() and not (v_target_company = get_my_company_id() and get_my_role() = 'owner') then
    raise exception 'Not authorized to revoke this session';
  end if;
  update user_sessions set revoked_at = now(), revoked_reason = p_reason
  where id = p_session_id and revoked_at is null;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sign_out_everywhere(p_target_user_id uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_target uuid;
  v_target_company uuid;
  v_count int;
begin
  if p_target_user_id is null or p_target_user_id = auth.uid() then
    v_target := auth.uid();
  else
    select company_id into v_target_company from employees where user_id = p_target_user_id;
    if v_target_company is null or v_target_company <> get_my_company_id() or get_my_role() <> 'owner' then
      raise exception 'Not authorized to sign out this user';
    end if;
    v_target := p_target_user_id;
  end if;
  update user_sessions set revoked_at = now(), revoked_reason = coalesce(revoked_reason, 'sign_out_everywhere')
  where user_id = v_target and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- Not SECURITY DEFINER -- plain trigger function, runs as whoever is doing the insert
CREATE OR REPLACE FUNCTION public.jobs_before_insert_lockdown()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
begin
  -- Prevents a public (anon) INSERT from ever setting status/claim fields
  -- directly -- every new job is forced to start as an unclaimed 'new' job
  -- no matter what the client sends.
  new.status := 'new';
  new.claimed_by := null;
  new.claimed_at := null;
  new.missed_lead_alert_sent_at := null;
  new.created_at := now();
  return new;
end;
$function$;


-- =============================================================================
-- TRIGGERS
-- =============================================================================
CREATE TRIGGER jobs_before_insert_lockdown_trigger
  BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_before_insert_lockdown();


-- =============================================================================
-- Regeneration query (paste into Supabase SQL Editor to refresh this file)
-- =============================================================================
-- select 'TABLES' as section, (select string_agg(table_name || '.' || column_name || ' pos=' || ordinal_position || ' default=' || coalesce(column_default,'NULL') || ' nullable=' || is_nullable || ' type=' || data_type || coalesce('(' || character_maximum_length || ')',''), E'\n' order by table_name, ordinal_position) from information_schema.columns where table_schema='public') as dump
-- union all select 'CONSTRAINTS', (select string_agg(conrelid::regclass::text || ' ' || conname || ': ' || pg_get_constraintdef(oid), E'\n' order by conrelid::regclass::text, conname) from pg_constraint where connamespace = 'public'::regnamespace)
-- union all select 'INDEXES', (select string_agg(indexname || ' ON ' || tablename || ': ' || indexdef, E'\n' order by tablename, indexname) from pg_indexes where schemaname='public')
-- union all select 'RLS_ENABLED', (select string_agg(c.relname || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity, E'\n' order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r')
-- union all select 'POLICIES', (select string_agg(tablename || ' | ' || policyname || ' | permissive=' || permissive || ' | cmd=' || cmd || ' | roles=' || array_to_string(roles, ',') || ' | using=' || coalesce(qual,'') || ' | with_check=' || coalesce(with_check,''), E'\n' order by tablename, policyname) from pg_policies where schemaname='public')
-- union all select 'GRANTS', (select string_agg(line, E'\n' order by line) from (select distinct table_name || ' | ' || grantee || ' | ' || privilege_type as line from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated','service_role','public')) t)
-- union all select 'FUNCTIONS', (select string_agg(p.proname || ':::' || pg_get_functiondef(p.oid), E'\n---\n' order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')
-- union all select 'TRIGGERS', (select string_agg(event_object_table || ' | ' || trigger_name || ' | ' || action_timing || ' ' || event_manipulation || ' | ' || action_statement, E'\n' order by event_object_table, trigger_name) from information_schema.triggers where trigger_schema='public')
-- union all select 'EXTENSIONS', (select string_agg(extname || ' ' || extversion, ', ' order by extname) from pg_extension);
