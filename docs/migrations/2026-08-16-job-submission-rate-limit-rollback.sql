-- Rollback for 2026-08-16-job-submission-rate-limit.sql
--
-- Restores submit_public_job() to the exact version from
-- docs/migrations/2026-08-11-fix-public-job-insert-tenant-binding.sql
-- (no rate-limit check, no submission-log write), then drops the new
-- rate-limit function, the job_submission_log table, and the two new
-- billing_guardrails columns. Run this before rolling back
-- 2026-08-11's migration if both are ever being reverted together (they
-- won't be in practice -- 2026-08-11 intentionally ships no rollback,
-- see that file's header -- but this keeps the ordering explicit).

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
begin
  select id into v_company_id from companies where subdomain = lower(p_subdomain) limit 1;
  if v_company_id is null then
    raise exception 'Unknown company';
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

  return v_job;
end;
$function$;

grant execute on function public.submit_public_job(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text[],text,text) to anon, authenticated;

drop function if exists public.check_job_submission_rate_limit(text, text);

drop table if exists public.job_submission_log;

alter table public.billing_guardrails
  drop column if exists per_ip_hourly_job_limit,
  drop column if exists per_company_daily_job_limit;
