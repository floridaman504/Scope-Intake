-- Rollback for 2026-08-16-error-log-pipeline.sql

drop function if exists public.cleanup_old_error_logs();

drop function if exists public.log_app_error(text, text, text, text, text, text, text);

drop table if exists public.error_log;

alter table public.billing_guardrails
  drop column if exists per_ip_hourly_error_log_limit;
