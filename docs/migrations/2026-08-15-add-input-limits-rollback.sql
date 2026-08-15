-- Rollback for 2026-08-15-add-input-limits.sql
--
-- Drops all the length/count CHECK constraints and resets the job-media
-- bucket back to unlimited size/type. Purely additive migration, so this
-- rollback is a clean, complete inverse -- no data was changed, only what's
-- allowed to be written going forward.

alter table jobs
  drop constraint if exists jobs_customer_name_length,
  drop constraint if exists jobs_customer_phone_length,
  drop constraint if exists jobs_customer_email_length,
  drop constraint if exists jobs_context_length,
  drop constraint if exists jobs_access_length,
  drop constraint if exists jobs_fixture_length,
  drop constraint if exists jobs_pipe_length,
  drop constraint if exists jobs_cutting_length,
  drop constraint if exists jobs_preference_length,
  drop constraint if exists jobs_leak_detection_length,
  drop constraint if exists jobs_ai_job_type_length,
  drop constraint if exists jobs_ai_urgency_length,
  drop constraint if exists jobs_ai_summary_length,
  drop constraint if exists jobs_ai_watch_out_length,
  drop constraint if exists jobs_media_count,
  drop constraint if exists jobs_ai_materials_count;

update storage.buckets
set
  file_size_limit = null,
  allowed_mime_types = null
where id = 'job-media';
