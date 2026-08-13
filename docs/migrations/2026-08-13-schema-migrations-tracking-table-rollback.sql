-- Rollback for 2026-08-13-schema-migrations-tracking-table.sql
--
-- Safe to run any time -- nothing else in the schema references this table
-- (no FKs point at it, no RLS policy or function reads from it). Removing
-- it just turns off the migration-tracking record; it does not undo any of
-- the migrations it recorded.

drop table if exists schema_migrations;
