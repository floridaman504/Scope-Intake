-- 2026-08-13: tighten anon/authenticated table-level grants (task #22,
-- cross-tenant isolation audit, docs/audits/2026-08-06-cross-tenant-isolation-audit.md)
--
-- Confirmed still outstanding via docs/schema/production-schema-2026-08-09.sql
-- (a live introspection snapshot from 4 days before this file, not a plan
-- doc): every one of the 9 tables that existed then granted ALL SEVEN
-- privileges (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
-- TRIGGER) to both anon and authenticated -- Supabase's default scaffold,
-- never scoped down. RLS is doing 100% of the real access control today,
-- so this isn't independently exploitable through the normal REST API --
-- but TRUNCATE bypasses RLS entirely (RLS only filters row-level
-- SELECT/INSERT/UPDATE/DELETE), and table-level grants are the only
-- backstop against a future SECURITY INVOKER function that forgets to
-- check role. Belt-and-suspenders, not a live vulnerability.
--
-- This SQL is NOT new/untested -- it's the exact grant scheme
-- sync-staging.yml has been applying to scope-staging on every sync since
-- task #23 (see that workflow's "Reapply anon/authenticated grants" step),
-- so it's already been running successfully against staging, exercised by
-- the app and by the cross-tenant-isolation-test.yml suite, ahead of this
-- migration ever touching production. This migration is what makes
-- production match what staging has already proven out.
--
-- Table list is wider than the 9 in the 08-09 snapshot -- job_notes,
-- pricebook_items, job_estimates, job_estimate_line_items were added by
-- later migrations (dispatcher dashboard, pricing estimator) and need the
-- same tightening. companies, billing_guardrails, login_attempts
-- intentionally receive ZERO anon/authenticated grants (no policy ever
-- grants them access; matches sync-staging.yml and the minimal-privilege
-- scheme task #22 recommends).
--
-- Expand-only in spirit even though it's revoke+grant, not add: nothing
-- currently reachable through RLS becomes unreachable, because every
-- grant a live policy actually depends on is re-granted below. If this
-- assumption is wrong for some path this file's author missed, that
-- shows up immediately as a permission-denied error, not silent data
-- loss -- a safe failure mode. Test on staging first per the playbook
-- anyway (test-migration-on-staging.yml); staging already runs this exact
-- SQL, so that run should be a no-op confirming nothing regressed.

grant usage on schema public to anon, authenticated;

revoke all on all tables in schema public from anon, authenticated;

grant insert on public.jobs to anon;
grant select, insert, update, delete on public.jobs to authenticated;
grant select on public.employees to authenticated;
grant select on public.user_sessions to authenticated;
grant select on public.session_policy to authenticated;
grant select, insert on public.invite_codes to authenticated;
grant select on public.ai_usage_log to authenticated;
grant select, insert on public.job_notes to authenticated;
grant select, insert, update, delete on public.pricebook_items to authenticated;
grant select, insert, update on public.job_estimates to authenticated;
grant select, insert, update, delete on public.job_estimate_line_items to authenticated;
-- companies, billing_guardrails, login_attempts, schema_migrations
-- intentionally receive no anon/authenticated grants.

-- Verification queries (run after applying):
--   select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type)
--     from information_schema.role_table_grants
--     where table_schema = 'public' and grantee in ('anon', 'authenticated')
--     group by 1, 2 order by 1, 2;
--   -- expect exactly the grants listed above, nothing broader.
--   -- Then click through the app end-to-end (public intake submit + upload,
--   -- login, dashboard, jobs queue claim, dispatcher pricing estimator,
--   -- session registry, sign-out-everywhere) to confirm nothing that
--   -- worked before now fails on a missing grant.
