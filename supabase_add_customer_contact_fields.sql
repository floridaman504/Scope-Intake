-- Adds customer contact info (name, phone, email) to the jobs table.
-- Without this, a customer could submit a full job brief with no way
-- for the company to actually call them back -- the form was missing
-- its most basic operational requirement.
--
-- Contact PII is intentionally NOT sent to the AI review endpoint
-- (see api/review-job.js / ScopeIntake.jsx's excludeFromAiSummary
-- field flag) -- it's stored directly here instead.

alter table jobs add column if not exists customer_name text;
alter table jobs add column if not exists customer_phone text;
alter table jobs add column if not exists customer_email text;

create or replace function submit_public_job(
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
  p_pets text,
  p_ai_job_type text,
  p_ai_urgency text,
  p_ai_materials text[],
  p_ai_summary text,
  p_ai_watch_out text
)
returns jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_job jobs%rowtype;
begin
  select id into v_company_id
  from companies
  where subdomain = lower(p_subdomain)
  limit 1;

  if v_company_id is null then
    raise exception 'Unknown company';
  end if;

  insert into jobs (
    company_id, customer_name, customer_phone, customer_email, context,
    fixture, pipe, access, cutting, preference, leak_detection, pets,
    ai_job_type, ai_urgency, ai_materials, ai_summary, ai_watch_out,
    status
  ) values (
    v_company_id, p_customer_name, p_customer_phone, p_customer_email,
    p_context, p_fixture, p_pipe, p_access, p_cutting, p_preference,
    p_leak_detection, p_pets, p_ai_job_type, p_ai_urgency,
    p_ai_materials, p_ai_summary, p_ai_watch_out, 'new'
  )
  returning * into v_job;

  return v_job;
end;
$$;

-- The old 14-argument signature (from the pets-field migration) is now
-- shadowed by the 17-argument one above. Drop it explicitly so there's
-- no ambiguity for callers/PostgREST.
drop function if exists submit_public_job(
  text, text, text, text, text, text, text, text, text, text, text, text[], text, text
);

grant execute on function submit_public_job(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text, text[], text, text
) to anon, authenticated;
