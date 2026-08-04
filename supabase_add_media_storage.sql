-- Storage bucket + RLS for customer-submitted job photos/video, plus a
-- jobs.media column recording what got uploaded against each job.
--
-- Bucket is PRIVATE, not public -- these are often photos inside someone's
-- home (a leaking pipe under a sink, a water heater in a closet, etc.).
-- Employees will view them via signed URLs generated on demand from the
-- dispatch dashboard (task #10), not permanent public links.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'job-media',
  'job-media',
  false,
  52428800, -- 50MB per file (server-side hard cap; client also checks before upload)
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime', 'video/webm']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table jobs add column if not exists media jsonb not null default '[]'::jsonb;

-- Path convention is "<job_id>/<random>-<filename>". Anyone (anon or
-- authenticated) can upload, but ONLY into a path prefixed with a job id
-- that already exists in the jobs table -- i.e. you need a real job id
-- from a just-completed submit_public_job() call to upload into it. Job
-- ids are effectively unguessable UUIDs, so this rules out blind/random
-- storage spam even though the bucket itself has no per-request auth.
drop policy if exists "anon_can_upload_to_valid_job" on storage.objects;
create policy "anon_can_upload_to_valid_job"
on storage.objects for insert
to anon, authenticated
with check (
  bucket_id = 'job-media'
  and exists (
    select 1 from jobs where jobs.id::text = split_part(storage.objects.name, '/', 1)
  )
);

-- Employees can only see media that belongs to a job in their own
-- company -- same tenant-isolation pattern as the jobs table policies.
drop policy if exists "employees_select_own_company_media" on storage.objects;
create policy "employees_select_own_company_media"
on storage.objects for select
to authenticated
using (
  bucket_id = 'job-media'
  and exists (
    select 1 from jobs
    where jobs.id::text = split_part(storage.objects.name, '/', 1)
      and jobs.company_id = get_my_company_id()
  )
);

-- attach_job_media(): called by the client AFTER files are uploaded to
-- Storage, to record what's there against the job row. Re-validates the
-- job belongs to the claimed subdomain (defense in depth -- same pattern
-- as submit_public_job()) before writing, so a submitter can't attach
-- media to a job that isn't theirs by guessing another job's id.
create or replace function attach_job_media(
  p_job_id uuid,
  p_subdomain text,
  p_media jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  select id into v_company_id from companies where subdomain = lower(p_subdomain) limit 1;
  if v_company_id is null then
    raise exception 'Unknown company';
  end if;

  update jobs
  set media = p_media
  where id = p_job_id
    and company_id = v_company_id;
end;
$$;

grant execute on function attach_job_media(uuid, text, jsonb) to anon, authenticated;
