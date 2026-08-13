-- 2026-08-12: Wire up real Supabase Storage for job media (Priority 1a)
--
-- Context: docs/audits/2026-08-08-frontend-health-audit.md (frontend) and the
-- database/storage audit both flagged this as the most urgent finding across
-- all four audits. ScopeIntake.jsx's handleFile used
-- URL.createObjectURL(f) -- a blob URL that only ever exists in the
-- customer's own browser tab -- and only {name, type} metadata ever reached
-- the database. A customer could photograph their leak, attach it, submit,
-- and the photo would never reach the plumber or dispatcher. This migration
-- creates the actual storage bucket and the RLS policies that let the app
-- code (already updated in src/ScopeIntake.jsx and src/JobsQueue.jsx) upload
-- and read real files.
--
-- Design: private bucket, path convention {company_id}/{job_id}/{filename}.
-- No new secret/service-role usage anywhere in this flow -- everything runs
-- with the same anon/authenticated keys already in the browser.
--
--   INSERT (anon): safe to allow directly because jobs.id is an unguessable
--   gen_random_uuid() -- same trust model already used for the
--   password-reset link's recovery token. submit_public_job() (SECURITY
--   DEFINER) resolves company_id server-side and returns the full job row,
--   so the client only ever learns its OWN new job's id/company_id from a
--   trusted server response, never by guessing someone else's. The policy
--   below independently re-verifies that the path's company_id/job_id pair
--   actually corresponds to a real job before allowing the write -- so even
--   a client that fabricated a path gets rejected, not just inconvenienced.
--
--   SELECT (authenticated): mirrors jobs_select_company exactly -- an
--   employee can only read media whose path's company_id matches their own
--   employees.company_id.
--
-- DEPENDENCY: the SELECT policy below references employees.deactivated_at,
-- added in docs/migrations/2026-08-12-employee-deactivation-and-email-constraint.sql.
-- Apply that migration FIRST, or this one will fail with
-- "column deactivated_at does not exist."
--
-- Verification queries (run after applying):
--   select id, public from storage.buckets where id = 'job-media'; -- expect public = false
--   select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like '%job_media%';

insert into storage.buckets (id, name, public)
values ('job-media', 'job-media', false)
on conflict (id) do nothing;

create policy job_media_insert_matches_real_job
on storage.objects for insert to anon
with check (
    bucket_id = 'job-media'
    and exists (
      select 1 from jobs j
      where j.id::text = (storage.foldername(name))[2]
        and j.company_id::text = (storage.foldername(name))[1]
    )
  );

create policy job_media_select_own_company
on storage.objects for select to authenticated
using (
    bucket_id = 'job-media'
    and exists (
      select 1 from employees e
      where e.user_id = auth.uid()
        and e.deactivated_at is null
        and e.company_id::text = (storage.foldername(name))[1]
    )
  );
