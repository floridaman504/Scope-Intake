-- 2026-08-13: schema_migrations tracking table (migration pipeline, step 1 of 3)
--
-- Context: production DDL has always been applied by hand, one-off, via the
-- Supabase SQL editor -- every file in this folder was written here, then
-- pasted and run manually, then this folder updated to say so after the
-- fact. That worked, but it has a real gap: nothing records WHICH files
-- have actually been run against production, so there's no way to tell
-- "already applied" from "still pending" except by asking whoever ran it
-- last, or by hand-checking the live schema. That gap let
-- supabase_session_hardening.sql sit live in production for days while its
-- own header comment still said "NOT YET APPLIED... pending Dante's
-- go-ahead" (caught and fixed 2026-08-13). Supabase's own audit log isn't
-- available on the Free/Pro plan (confirmed directly against this
-- project's dashboard), so there's no independent record of what ran when,
-- either.
--
-- This table plus the two new GitHub Actions workflows
-- (apply-migration.yml, test-migration-on-staging.yml) close that gap:
-- migrations still live as plain SQL files in this folder, reviewed via a
-- normal PR like any other change, but the actual "run this against
-- production" step becomes a logged, attributable Action run instead of an
-- unlogged SQL-editor paste. The Action's own run history (who triggered
-- it, when, which file) becomes the audit trail Supabase's plan doesn't
-- give this project.
--
-- Fully additive -- one new table, nothing existing touched. No pre-flight
-- needed.
--
-- Bootstrapping note: apply-migration.yml creates this table itself (`create
-- table if not exists`) as a guard step before doing anything else, so the
-- very first real run of that workflow works even before this specific
-- file has been applied through it. Running this file is then a no-op
-- reconciliation, same pattern as supabase_session_hardening.sql being
-- safely re-runnable.

create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now(),
      applied_via text not null default 'manual',
      notes text
    );

comment on table schema_migrations is
  'Tracks which docs/migrations/*.sql files have been applied to this database. Written to by apply-migration.yml (applied_via=''github-actions:<run id>'') and, for migrations that predate this table, by a one-time verified backfill (applied_via=''backfill:<how it was verified>''). Never written to by app code.';

-- No RLS needed: this table is never queried by anon/authenticated, only by
-- the migration workflows themselves using the SUPABASE_DB_URL /
-- STAGING_DB_URL connection strings, which bypass RLS as the table owner.
-- Deliberately NOT granting select/insert to anon or authenticated (matches
-- the minimal-privilege scheme from the cross-tenant audit -- a table with
-- no grants is invisible to both roles, same as companies/billing_guardrails).

-- Verification queries (run after applying):
--   select to_regclass('public.schema_migrations'); -- expect 'schema_migrations', not null
--   select has_table_privilege('anon', 'schema_migrations', 'select'); -- expect false
--   select has_table_privilege('authenticated', 'schema_migrations', 'select'); -- expect false
