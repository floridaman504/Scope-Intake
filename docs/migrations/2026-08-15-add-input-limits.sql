-- 2026-08-15: Add input limits (Tier 2 #9, input validation finding)
--
-- Context: docs/scope-operational-playbook.md Tier 2 item #9 (core security
-- hardening) flagged that no text field or file upload anywhere in this app
-- has a size limit -- confirmed by a full audit. The `jobs` table's text
-- columns and the `job-media` storage bucket both accept unbounded input
-- today. Concretely: a customer's `context` answer is concatenated
-- (unbounded) into the prompt api/review-job.js sends to the AI, on a
-- public, unauthenticated endpoint -- a real prompt-injection and
-- unbounded-cost vector. File uploads have no server-side size or type
-- check at all, only a client-side `accept` hint anyone can bypass.
--
-- This migration is defense-in-depth, not the only fix -- api/review-job.js
-- and src/ScopeIntake.jsx also got matching client/server-side limits in
-- this same PR. The point of putting limits at the database layer too is
-- that even if the application-layer checks are ever bypassed, changed, or
-- have a bug, the database itself refuses to store something absurd.
--
-- Limits chosen to be generous for a real plumbing customer (nobody
-- describing "water pooling under the sink" needs anywhere close to 2000
-- characters) while still bounding the worst case. Adjust freely if a real
-- customer ever legitimately hits one of these -- they're a backstop, not
-- a carefully-tuned product decision.
--
-- Applied as an ALTER TABLE ADD CONSTRAINT in the SAME migration file as
-- always (see docs/audits/2026-08-08-migration-safety-playbook.md) -- this
-- runs inside apply-migration.yml's single transaction (-1 flag), so if any
-- EXISTING row in `jobs` already violates one of these constraints, the
-- whole statement fails cleanly and nothing is applied -- there is no
-- partial-damage state possible. That failure would show up as a clear
-- Postgres error in the workflow run's log (which row/constraint), not a
-- silent partial success.

alter table jobs
  add constraint jobs_customer_name_length check (char_length(customer_name) <= 200),
  add constraint jobs_customer_phone_length check (char_length(customer_phone) <= 30),
  add constraint jobs_customer_email_length check (char_length(customer_email) <= 320), -- RFC 5321 max
  add constraint jobs_context_length check (char_length(context) <= 2000),
  add constraint jobs_access_length check (char_length(access) <= 2000),
  add constraint jobs_fixture_length check (char_length(fixture) <= 500),
  add constraint jobs_pipe_length check (char_length(pipe) <= 200),
  add constraint jobs_cutting_length check (char_length(cutting) <= 200),
  add constraint jobs_preference_length check (char_length(preference) <= 200),
  add constraint jobs_leak_detection_length check (char_length(leak_detection) <= 200),
  -- ai_* columns are technically client-supplied too (submit_public_job's
  -- signature takes p_ai_job_type/p_ai_urgency/p_ai_materials/p_ai_summary/
  -- p_ai_watch_out as parameters -- the client is trusted to pass back
  -- whatever /api/review-job returned, but nothing stops a modified client
  -- from sending something else entirely), so they get the same treatment.
  add constraint jobs_ai_job_type_length check (char_length(ai_job_type) <= 200),
  add constraint jobs_ai_urgency_length check (char_length(ai_urgency) <= 50),
  add constraint jobs_ai_summary_length check (char_length(ai_summary) <= 2000),
  add constraint jobs_ai_watch_out_length check (char_length(ai_watch_out) <= 1000),
  -- Caps the number of attachments a single job can ever have linked, via
  -- attach_job_media(). Matches the client-side 8-file cap added to
  -- ScopeIntake.jsx in this same PR -- this is the server-side backstop.
  add constraint jobs_media_count check (jsonb_array_length(media) <= 8),
  add constraint jobs_ai_materials_count check (jsonb_array_length(ai_materials) <= 20);

-- Storage: the job-media bucket (docs/migrations/2026-08-12-job-media-storage-bucket.sql)
-- was created with no file_size_limit or allowed_mime_types -- Supabase's
-- own default for both is "unlimited." 25 MB comfortably covers a real
-- phone photo (typically 2-8 MB) and a short video clip; allowed_mime_types
-- mirrors the client's accept="image/*,video/*" hint with the actual
-- concrete formats phone cameras produce (iOS HEIC/HEIF/MOV, Android
-- JPEG/PNG/MP4/WebM/3GP), enforced server-side this time instead of only
-- as a client-side UI hint anyone could bypass.
update storage.buckets
set
  file_size_limit = 26214400, -- 25 MB in bytes
  allowed_mime_types = array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'
  ]
where id = 'job-media';

-- Verification queries used after applying:
--   select conname from pg_constraint where conrelid = 'jobs'::regclass and conname like '%_length' or conname like '%_count'; -- expect 13 rows
--   select file_size_limit, allowed_mime_types from storage.buckets where id = 'job-media'; -- expect 26214400 and the 9-item array above
