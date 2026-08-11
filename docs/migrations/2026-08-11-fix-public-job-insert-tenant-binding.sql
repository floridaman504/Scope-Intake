-- 2026-08-11: Fix public job intake tenant-binding vulnerability
--
-- Context: docs/audits/2026-08-11-public-job-insert-tenant-binding-fix.md
--
-- The jobs table had picked up an INSERT policy (jobs_insert_public) that
-- allowed anon/authenticated inserts as long as company_id was non-null and
-- referenced a real company (via company_exists()). Nothing tied that
-- company_id to the subdomain the request actually came from -- so any
-- visitor to any tenant's intake form could read another tenant's
-- company_id (get_company_by_subdomain was anon-callable) and insert jobs
-- directly into that tenant's queue with the public anon key.
--
-- submit_public_job() already existed as the correct, safe pattern
-- (SECURITY DEFINER, resolves company_id server-side from subdomain) but
-- the app had drifted off it. This migration restores it under an updated
-- signature (p_media jsonb replacing the unused legacy p_pets text),
-- removes the loose INSERT policy so ALL public submissions are forced
-- through the verified RPC, and closes the secondary company-id
-- enumeration angle by revoking anon access to the two lookup RPCs.
--
-- Applied directly against production via the Supabase SQL editor on
-- 2026-08-11.

-- 1. Drop the old signature (p_pets text) and recreate with p_media jsonb.
drop function if exists public.submit_public_job(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text[],text,text);

create function public.submit_public_job(
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

-- 2. Remove the vulnerable direct-insert policy. All public submissions
--    now have to go through submit_public_job().
drop policy if exists jobs_insert_public on jobs;

-- 3. Close the company-id enumeration angle: these two lookup RPCs let an
--    anonymous caller resolve/verify any company_id by subdomain, which
--    was the mechanism that made jobs_insert_public exploitable across
--    tenants. Nothing on the client needs them anymore now that
--    submit_public_job() resolves company_id server-side. Revoking from
--    PUBLIC (not just anon) is required -- PUBLIC grants are inherited by
--    every role including anon, so revoking from anon alone is a no-op
--    while the PUBLIC grant still exists.
revoke execute on function public.get_company_by_subdomain(text) from public;
grant execute on function public.get_company_by_subdomain(text) to authenticated;

revoke execute on function public.company_exists(uuid) from public;
grant execute on function public.company_exists(uuid) to authenticated;

-- Verification queries used after applying:
--   select count(*) from pg_policies where schemaname='public' and tablename='jobs' and policyname='jobs_insert_public'; -- expect 0
--   select pg_get_function_arguments(oid) from pg_proc where proname='submit_public_job'; -- confirm p_media jsonb signature
--   select grantee from information_schema.routine_privileges where routine_name='get_company_by_subdomain'; -- expect no anon/PUBLIC
