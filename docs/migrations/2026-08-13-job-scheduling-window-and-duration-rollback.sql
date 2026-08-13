-- Rollback for 2026-08-13-job-scheduling-window-and-duration.sql

alter table jobs drop constraint if exists jobs_estimated_duration_positive_chk;
alter table jobs drop constraint if exists jobs_scheduled_window_order_chk;

alter table jobs drop column if exists estimated_duration_minutes;
alter table jobs drop column if exists scheduled_end;
alter table jobs drop column if exists scheduled_start;
