-- 2026-08-13: Time-window scheduling + plumber/owner-set job duration.
--
-- Context: jobs-view redesign, confirmed with Dante after two rounds of
-- competitor UX research (Jobber/Housecall Pro/ServiceTitan, then Workiz/
-- Kickserv/FieldEdge/BuildOps/Fergus/Tradify/Service Fusion/mHelpDesk/
-- FieldPulse + G2/Capterra review mining). Confirmed via schema read that
-- jobs has NO scheduling field at all today -- this is fully additive.
--
-- Design decision (picked by Dante from three options): scheduled_start/
-- scheduled_end and estimated_duration_minutes are INDEPENDENT fields, not
-- linked. The dispatcher sets the calendar window (start/end) when booking
-- a job -- that's their call, matches their existing owner/dispatcher
-- raw-UPDATE access to jobs. estimated_duration_minutes is separate data,
-- settable only by the owner or the plumber(s) actually assigned to the
-- job, NEVER by the dispatcher ("the dispatcher will not know" -- Dante's
-- own words). Setting duration never moves the calendar block. This
-- sidesteps the #1 complaint found in Workiz reviews (users confusing an
-- "estimate" with the actual "scheduled job") by keeping the two visibly
-- and structurally separate, and leaves room for a later phase to
-- auto-suggest windows from historical duration data.
--
-- Column-level write scoping is NOT something Postgres RLS can do directly
-- (RLS is row-level; USING/WITH CHECK each only see one version of the
-- row, not old-vs-new). Two different, deliberately different enforcement
-- paths:
--   - scheduled_start/scheduled_end: owner + dispatcher already have full
--     raw UPDATE access to every column on jobs via the existing
--     jobs_update_owner_dispatcher_company policy (see production schema).
--     No new grant needed -- the app just starts writing these two columns
--     through that existing path.
--   - estimated_duration_minutes: plumbers have ZERO raw UPDATE access to
--     jobs today (no policy grants it), so a new SECURITY DEFINER RPC
--     (set_job_duration, next migration file) is the only way for a
--     plumber to write it. Owner uses the same RPC rather than a second
--     code path. Dispatcher is blocked from writing this column at the DB
--     level too, not just in the UI: this schema already has precedent for
--     exactly this shape of problem (jobs_before_update_assignment_lock,
--     2026-08-09, blocks a dispatcher from reassigning claimed_by via raw
--     UPDATE despite holding full-row UPDATE grant) -- the next migration
--     file adds a matching trigger for estimated_duration_minutes so the
--     restriction holds even if someone bypasses the UI and issues a raw
--     client update.

alter table jobs add column if not exists scheduled_start timestamptz;
alter table jobs add column if not exists scheduled_end timestamptz;
alter table jobs add column if not exists estimated_duration_minutes integer;

alter table jobs
  add constraint jobs_scheduled_window_order_chk
  check (scheduled_end is null or scheduled_start is null or scheduled_end > scheduled_start);

alter table jobs
  add constraint jobs_estimated_duration_positive_chk
  check (estimated_duration_minutes is null or estimated_duration_minutes > 0);

-- Verification queries (run after applying):
--   select column_name, data_type from information_schema.columns
--     where table_name = 'jobs' and column_name in ('scheduled_start','scheduled_end','estimated_duration_minutes');
--   -- expect 3 rows
--   select conname from pg_constraint where conname in ('jobs_scheduled_window_order_chk','jobs_estimated_duration_positive_chk');
--   -- expect 2 rows
--   select count(*) from jobs where scheduled_start is not null or scheduled_end is not null or estimated_duration_minutes is not null;
--   -- expect 0 immediately after applying (nothing populates these columns yet)
