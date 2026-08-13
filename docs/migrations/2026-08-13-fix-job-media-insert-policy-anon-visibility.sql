-- 2026-08-13: Fix job-media INSERT policy -- anon can't see jobs via RLS
--
-- Live end-to-end test (submitting a real job with a photo through the
-- public intake form on production) failed with "new row violates row-level
-- security policy" for the job-media bucket's anon INSERT policy
-- (job_media_insert_matches_real_job, added in
-- docs/migrations/2026-08-12-job-media-storage-bucket.sql).
--
-- Root cause: that policy's WITH CHECK does
-- `exists (select 1 from jobs j where ...)` -- but this subquery runs as
-- the calling role (anon), and jobs' only RLS policies
-- (jobs_select_company, jobs_update_owner_dispatcher_company,
-- jobs_delete_owner_company) are all scoped to 'authenticated'. There is no
-- SELECT policy granting anon any visibility into jobs at all. So the
-- subquery returns zero rows for an anon caller regardless of whether the
-- job actually exists -- the check was unsatisfiable for exactly the case
-- it was written for (a customer, not logged in, uploading a photo for the
-- job they just created). Confirmed via the browser console error
-- (StorageApiError: new row violates row-level security policy) and by
-- verifying the job row existed with matching id/company_id immediately
-- after the failed upload.
--
-- Fix: move the existence check into a SECURITY DEFINER function, same
-- pattern already used for get_my_company_id()/get_my_role(). It runs with
-- the privileges of its owner (bypassing jobs' RLS internally for this one
-- lookup) while still only ever answering a single yes/no existence
-- question for a specific (company_id, job_id) pair -- it does not expose
-- any job data (customer name, phone, address, etc.) to the caller, and
-- both ids are unguessable gen_random_uuid()s, so this isn't a new
-- information-disclosure surface beyond what the INSERT allow/deny already
-- implied.
--
-- Also granted to 'authenticated', not just 'anon': the live test above
-- happened to run in a browser tab that still had a stored employee
-- session (sb-*-auth-token in localStorage), so the Storage API called
-- this policy as 'authenticated', not 'anon' -- a realistic case (a shared
-- device, or staff pulling up the public form), not just a test artifact.
--
-- Also found and removed two PRE-EXISTING policies/functions on this same
-- table that predate this migration and are independently broken --
-- leftovers from an earlier, abandoned attempt at this same feature using
-- a different (and never-completed) path convention:
--   - anon_can_upload_to_valid_job (INSERT, {anon,authenticated}), backed by
--     job_exists(p_job_id) -- but the policy passed it
--     split_part(name,'/',1), which is the COMPANY id in this schema's path
--     convention ({company_id}/{job_id}/{filename}), not the job id. It
--     compares that against jobs.id, so it can only ever match by
--     coincidence -- it was already effectively dead (fails safe, not
--     exploitable), but very confusing to debug against and worth
--     removing now that it's identified.
--   - employees_select_own_company_media (SELECT, {authenticated}), same
--     mistake: compares split_part(name,'/',1) (company id) against
--     jobs.id.
-- Neither weakened security (both simply never matched), but both are dead
-- code from a different design that was never finished, and this project's
-- job-media bucket now has exactly one INSERT and one SELECT policy again
-- after this migration, matching the original 2026-08-12 migration's
-- intent.

create or replace function public.job_media_path_is_valid(p_company_id text, p_job_id text)
returns boolean
language sql stable security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from jobs j
    where j.id::text = p_job_id
      and j.company_id::text = p_company_id
  );
$function$;

drop policy if exists job_media_insert_matches_real_job on storage.objects;

create policy job_media_insert_matches_real_job
on storage.objects for insert to anon, authenticated
with check (
  bucket_id = 'job-media'
  and public.job_media_path_is_valid(
    (storage.foldername(name))[1],
    (storage.foldername(name))[2]
  )
);

-- Cleanup: dead, broken, pre-existing duplicates (see note above).
drop policy if exists anon_can_upload_to_valid_job on storage.objects;
drop policy if exists employees_select_own_company_media on storage.objects;
drop function if exists public.job_exists(text);

-- Verification queries (run after applying):
--   select proname from pg_proc where proname = 'job_media_path_is_valid'; -- expect 1 row
--   select proname from pg_proc where proname = 'job_exists'; -- expect 0 rows
--   select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects'; -- expect exactly job_media_insert_matches_real_job (INSERT) and job_media_select_own_company (SELECT)
--   -- then re-run the live intake form test with a photo attached and confirm
--   -- no RLS error in the browser console and the file appears under
--   -- job-media/{company_id}/{job_id}/ in the Storage dashboard.
