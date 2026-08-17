-- 2026-08-16: Centralized error logging pipeline (Tier 2 #10 of
-- docs/scope-operational-playbook.md, "Error Handling Rebuild", parts 2
-- and 3 -- boundary coverage and the logging pipeline itself). Part 1
-- (never send a stack trace/DB error to the client) already shipped --
-- see docs/audits/2026-08-16-error-handling.md and
-- api/_lib/errorResponse.js / src/errorMessages.js.
--
-- What this closes: those two helpers, and the top-level React
-- ErrorBoundary, currently only ever send the REAL error to a
-- console -- the browser's console (only visible to whoever has devtools
-- open on that exact tab, in that exact moment) or Vercel's own function
-- logs (not part of this app's database, and on Vercel's free tier,
-- short-retention). Nobody ever comes back to look at either one later.
-- Concretely: api/check-missed-leads.js already tracks per-job send/mark
-- failures in a `failures` array in its own JSON response -- but that
-- response is only ever read by a `curl` call from a scheduled GitHub
-- Actions workflow that discards it. If the missed-lead email provider
-- started silently rejecting every send again (this has happened before,
-- see that file's BUGFIX comment), nobody would know until a customer
-- complained.
--
-- This adds one durable place errors land: a new `error_log` table,
-- written only through a rate-limited SECURITY DEFINER RPC (same
-- guardrail pattern as job_submission_log/2026-08-16-job-submission-rate-limit.sql),
-- readable only by an owner, with a 90-day retention cleanup.

alter table public.billing_guardrails
  add column per_ip_hourly_error_log_limit integer not null default 50;

-- ---------------------------------------------------------------------------
-- error_log
-- ---------------------------------------------------------------------------
create table public.error_log (
  id           uuid not null default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  severity     text not null check (severity in ('error', 'warning', 'info')),
  source       text not null, -- e.g. 'api:review-job', 'client:ui', 'client:ErrorBoundary'
  route        text,          -- e.g. '/api/review-job', '/dashboard'
  http_method  text,          -- set for API-originated entries, null for client-side ones
  message      text not null, -- the same safe/public-facing message already shown or returned
  detail       text,          -- raw error message + stack trace -- owner-only, see RLS below
  employee_id  uuid,
  company_id   uuid,
  ip_address   text,
  user_agent   text,
  constraint error_log_pkey primary key (id),
  constraint error_log_employee_id_fkey foreign key (employee_id) references employees(id),
  constraint error_log_company_id_fkey foreign key (company_id) references companies(id)
);

create index error_log_created_at_idx on public.error_log (created_at desc);
create index error_log_severity_idx on public.error_log (severity);
create index error_log_route_idx on public.error_log (route);

alter table public.error_log enable row level security;

-- An owner can see their own company's entries, plus entries with no
-- company at all (public-page/pre-auth errors -- the customer intake
-- form, a failed AI review call before any employee session exists).
-- This mirrors audit_log_select_owner_company's shape but widens it for
-- the pre-auth case, which audit_log never has to deal with (every
-- audit_log row is always tied to a real employee action).
create policy error_log_select_owner on public.error_log
  for select to authenticated
  using ((company_id = get_my_company_id() or company_id is null) and get_my_role() = 'owner');

-- A brand-new table starts with NO grants to anon/authenticated at all
-- (2026-08-13-tighten-table-grants.sql revoked the old blanket default and
-- nothing re-grants it automatically for tables created afterward) -- RLS
-- alone doesn't let src/ErrorLog.jsx's direct .from('error_log').select()
-- read anything without this, exactly like audit_log needed its own
-- explicit grant. No insert/update/delete grant to anyone: writes only
-- ever happen via log_app_error() below, which bypasses RLS/grants the
-- same way submit_public_job()/redeem_invite_code()/etc. already do.
grant select on public.error_log to authenticated;

create or replace function public.log_app_error(
  p_severity text,
  p_source text,
  p_route text,
  p_http_method text,
  p_message text,
  p_detail text,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_guard billing_guardrails%rowtype;
  v_ip text;
  v_recent_count int;
  v_severity text;
  v_employee_id uuid;
  v_company_id uuid;
begin
  -- Never let a caller-supplied severity produce a constraint violation --
  -- logging must never itself throw. Anything unrecognized just becomes
  -- 'error', the safest default for triage.
  v_severity := case when p_severity in ('error', 'warning', 'info') then p_severity else 'error' end;

  begin
    v_ip := trim(split_part((current_setting('request.headers', true)::json ->> 'x-forwarded-for'), ',', 1));
  exception when others then
    v_ip := null;
  end;
  v_ip := coalesce(nullif(v_ip, ''), 'unknown');

  -- Same rate-limit shape as check_job_submission_rate_limit(): this RPC
  -- is anon-callable (client-side errors happen before any login exists),
  -- which makes it a public write surface like submit_public_job() --
  -- cap it the same way rather than trusting volume to stay low.
  -- Silently dropping past the limit (not raising) is deliberate: a
  -- logging call must never turn into a user-facing failure of its own.
  select * into v_guard from billing_guardrails where id = 1;
  if v_guard is not null then
    select count(*) into v_recent_count from error_log
    where ip_address = v_ip and created_at > now() - interval '1 hour';
    if v_recent_count >= v_guard.per_ip_hourly_error_log_limit then
      return;
    end if;
  end if;

  select id, company_id into v_employee_id, v_company_id
  from employees where user_id = auth.uid() and deactivated_at is null;

  insert into error_log (severity, source, route, http_method, message, detail, employee_id, company_id, ip_address, user_agent)
  values (
    v_severity,
    left(coalesce(p_source, 'unknown'), 200),
    left(p_route, 300),
    left(p_http_method, 10),
    left(coalesce(p_message, ''), 2000),
    left(p_detail, 8000),
    v_employee_id,
    v_company_id,
    v_ip,
    left(p_user_agent, 300)
  );
end;
$function$;

grant execute on function public.log_app_error(text, text, text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Retention: 90 days minimum (playbook's explicit floor). Called daily by
-- the existing supabase-backup.yml workflow, right after the backup step --
-- same credential, same psql install, no new secrets needed. See that
-- workflow file for the added step.
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_old_error_logs()
returns void
language sql
security definer
set search_path to 'public'
as $$
  delete from error_log where created_at < now() - interval '90 days';
$$;

-- Verification queries used after applying:
--   select conname from pg_constraint where conrelid = 'error_log'::regclass; -- expect pkey + 2 fkeys + severity check
--   select policyname from pg_policies where tablename = 'error_log'; -- expect error_log_select_owner
--   select has_table_privilege('anon', 'error_log', 'select'); -- expect false
--   select has_table_privilege('authenticated', 'error_log', 'select'); -- expect true (the grant); RLS still restricts which ROWS come back to owner-only
--   select proname from pg_proc where proname in ('log_app_error','cleanup_old_error_logs');
