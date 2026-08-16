-- 2026-08-16: Rate-limit public job submissions (Tier 2 #11 of
-- docs/scope-operational-playbook.md, "DDoS / WAF / Rate Limiting").
--
-- Context: submit_public_job() is a SECURITY DEFINER function callable by
-- anyone with the app's anon key, which is public (it ships in the
-- browser bundle -- that's normal and safe for Supabase's anon key, but
-- it does mean anyone can call submit_public_job() directly via
-- Supabase's REST API, not just through the intake form). Until this
-- migration, nothing capped how many jobs a single source could create.
-- That's not a money risk the way the AI review endpoint is (no metered
-- third-party API call happens here) -- it's a spam/operational risk: a
-- bot in a loop could flood a company's job queue with garbage,
-- indistinguishable at a glance from real customer requests, burying
-- the real ones.
--
-- This mirrors the existing check_rate_limit()/billing_guardrails
-- pattern already protecting the AI review endpoint (api/review-job.js)
-- -- same shape, same conservative "log first, block second" design --
-- rather than introducing a new pattern.
--
-- Limits default generously above any real single company's legitimate
-- traffic (a plumbing company getting 10 genuine intake submissions from
-- the same customer IP in an hour, or 200 in a day company-wide, would
-- be an extraordinary day) so real customers never notice this exists.

alter table public.billing_guardrails
  add column per_ip_hourly_job_limit integer not null default 10,
  add column per_company_daily_job_limit integer not null default 200;

-- ---------------------------------------------------------------------------
-- job_submission_log -- one row per accepted public job submission, purely
-- for rate-limit counting (not a customer-facing or audit-trail table).
-- ---------------------------------------------------------------------------
create table public.job_submission_log (
  id          uuid not null default gen_random_uuid(),
  company_id  uuid,
  ip_address  text,
  created_at  timestamptz not null default now(),
  constraint job_submission_log_pkey primary key (id),
  constraint job_submission_log_company_id_fkey foreign key (company_id) references companies(id)
);

create index job_submission_log_ip_created_idx on public.job_submission_log (ip_address, created_at);
create index job_submission_log_company_created_idx on public.job_submission_log (company_id, created_at);

-- No RLS policy needed: this table is never queried by the app (anon or
-- authenticated) -- only written and read by the SECURITY DEFINER
-- functions below, which run with elevated privilege regardless of RLS.
alter table public.job_submission_log enable row level security;

create or replace function public.check_job_submission_rate_limit(p_subdomain text, p_ip text)
returns text
language plpgsql security definer
set search_path to 'public'
as $function$
declare
  v_guard billing_guardrails%rowtype;
  v_company_id uuid;
  v_ip_count int;
  v_company_count int;
begin
  select * into v_guard from billing_guardrails where id = 1;
  if v_guard is null then return null; end if;

  select count(*) into v_ip_count from job_submission_log
  where ip_address = p_ip and created_at > now() - interval '1 hour';
  if v_ip_count >= v_guard.per_ip_hourly_job_limit then return 'rate_limited_ip'; end if;

  select id into v_company_id from companies where subdomain = lower(coalesce(p_subdomain, '')) limit 1;
  if v_company_id is not null then
    select count(*) into v_company_count from job_submission_log
    where company_id = v_company_id and created_at > now() - interval '24 hours';
    if v_company_count >= v_guard.per_company_daily_job_limit then return 'rate_limited_company'; end if;
  end if;

  return null;
end;
$function$;

-- Replaces the version from
-- docs/migrations/2026-08-11-fix-public-job-insert-tenant-binding.sql
-- (the current live signature/body -- p_media jsonb, no p_pets param;
-- confirmed against that file rather than the older 2026-08-09 schema
-- snapshot, which predates it). Adds: IP extraction (same defensive
-- current_setting('request.headers', true) pattern already used by
-- employees_audit_log_trigger(), docs/migrations/2026-08-16-audit-trail.sql),
-- a rate-limit check before the insert, and a submission-log write after
-- it succeeds. Everything else -- parameters, the unknown-company check,
-- the jobs insert itself, the return shape -- is unchanged.
create or replace function public.submit_public_job(
  p_subdomain text,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_context text,
  p_fixture text,
  p_pipe text,
  p_access text,
  p_cutting text,
  p_preference text,
  p_leak_detection text,
  p_media jsonb,
  p_ai_job_type text,
  p_ai_urgency text,
  p_ai_materials text[],
  p_ai_summary text,
  p_ai_watch_out text
)
returns jobs
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company_id uuid;
  v_job jobs%rowtype;
  v_ip text;
  v_limit_code text;
begin
  select id into v_company_id from companies where subdomain = lower(p_subdomain) limit 1;
  if v_company_id is null then
    raise exception 'Unknown company';
  end if;

  begin
    v_ip := trim(split_part((current_setting('request.headers', true)::json ->> 'x-forwarded-for'), ',', 1));
  exception when others then
    v_ip := null;
  end;
  v_ip := coalesce(nullif(v_ip, ''), 'unknown');

  v_limit_code := check_job_submission_rate_limit(p_subdomain, v_ip);
  if v_limit_code is not null then
    raise exception 'Too many requests. Please try again later.' using errcode = 'P0001';
  end if;

  insert into jobs (
    company_id, customer_name, customer_phone, customer_email,
    context, fixture, pipe, access, cutting, preference, leak_detection,
    media, ai_job_type, ai_urgency, ai_materials, ai_summary, ai_watch_out, status
  ) values (
    v_company_id, p_customer_name, p_customer_phone, p_customer_email,
    p_context, p_fixture, p_pipe, p_access, p_cutting, p_preference, p_leak_detection,
    coalesce(p_media, '[]'::jsonb), p_ai_job_type, p_ai_urgency, to_json(p_ai_materials), p_ai_summary, p_ai_watch_out, 'new'
  )
  returning * into v_job;

  insert into job_submission_log (company_id, ip_address) values (v_company_id, v_ip);

  return v_job;
end;
$function$;

grant execute on function public.submit_public_job(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text[],text,text) to anon, authenticated;
