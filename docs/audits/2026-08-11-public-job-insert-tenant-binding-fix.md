# Public job intake tenant-binding fix

**Date:** 2026-08-11
**Status:** Fixed (production)
**Severity:** High -- cross-tenant data write, unauthenticated

## Summary

The public job intake form (`ScopeIntake.jsx`) was writing directly to the
`jobs` table with a client-supplied `company_id`, gated by an RLS policy
(`jobs_insert_public`) that only checked the id referred to *some* real
company -- not that it matched the subdomain the visitor was actually on.
Combined with an anon-callable lookup RPC that handed back any company's id
by subdomain, this meant an anonymous caller could enumerate tenants and
insert fabricated jobs into any company's dispatch queue using nothing but
the public anon key. This has been fixed in production as of 2026-08-11.

This is a **regression**, not a gap that was always there. The
[2026-08-06 cross-tenant isolation audit](2026-08-06-cross-tenant-isolation-audit.md)
explicitly verified the opposite: that `submit_public_job()` "resolves the
company server-side from the subdomain, so the public intake form can never
be tricked into writing a job under a different company's ID," and its
policy inventory at the time showed no direct INSERT policy on `jobs` at
all. Sometime after that audit, `jobs_insert_public` was added and the app
was pointed at a direct `.from('jobs').insert(...)` call instead of the
RPC, undoing that protection without anyone noticing -- the safe RPC was
never removed, just stopped being used.

## What was exploitable

1. `get_company_by_subdomain(p_subdomain)` was `SECURITY DEFINER` and
   grantable to `anon`. Any unauthenticated visitor could call it with a
   guessed or enumerated subdomain and get back that company's `id` and
   `name` -- effectively a public tenant directory.
2. `jobs_insert_public` (RLS policy on `jobs`, `INSERT`, roles
   `anon, authenticated`) only enforced
   `company_id IS NOT NULL AND company_exists(company_id)`. It had no way
   to know, and made no attempt to check, whether the `company_id` in the
   insert matched the subdomain the request came from.
3. `ScopeIntake.jsx` resolved `company_id` client-side via
   `get_company_by_subdomain` and then called
   `supabase.from('jobs').insert({ company_id, ... })` directly.

Chaining 1 and 2: capture any company's id from step 1, then insert jobs
under that `company_id` from a completely different tenant's form (or from
a raw API call, no form needed at all). This also bypassed the AI cost
guardrail in `api/review-job.js`, since that endpoint is only invoked by
the form's own flow, not enforced at the database layer.

## Fix

- **Restored `submit_public_job()`** as the only path for public job
  creation. It is `SECURITY DEFINER`, resolves `company_id` **server-side**
  from `p_subdomain` (`select id from companies where subdomain =
  lower(p_subdomain)`), and raises if the subdomain doesn't match a real
  company. The client can no longer supply `company_id` at all -- there is
  no parameter for it. Signature updated from the pre-regression version:
  `p_media jsonb` replaces the legacy, unused `p_pets text` parameter to
  match the current data model.
- **Dropped `jobs_insert_public`.** There is no longer any RLS policy that
  allows a direct `INSERT` into `jobs` from `anon` or unauthenticated
  `authenticated` traffic with an arbitrary `company_id`. All public
  submissions must go through the RPC.
- **Locked down the enumeration angle.** Revoked `EXECUTE` on
  `get_company_by_subdomain` and `company_exists` from `PUBLIC` (which
  `anon` inherits from -- revoking from `anon` alone is not sufficient,
  since `PUBLIC` grants are inherited by every role regardless of
  role-specific revokes), then re-granted `EXECUTE` to `authenticated`
  only. Neither function is called from any remaining client code path
  (confirmed via repo-wide search); they're preserved for authenticated,
  internal use rather than removed outright.
- **Rewired `ScopeIntake.jsx`** to call `supabase.rpc('submit_public_job',
  {...})` instead of `supabase.from('jobs').insert(...)`. No client code
  resolves or supplies `company_id` anymore.

Full DDL: [`docs/migrations/2026-08-11-fix-public-job-insert-tenant-binding.sql`](../migrations/2026-08-11-fix-public-job-insert-tenant-binding.sql).

## Verification

- `select count(*) from pg_policies where tablename='jobs' and
  policyname='jobs_insert_public'` -> `0`.
- `pg_get_function_arguments` on `submit_public_job` confirms the new
  `p_media jsonb` signature; grantees are `anon, authenticated` (plus
  `postgres`/`service_role`).
- `information_schema.routine_privileges` for `get_company_by_subdomain`
  and `company_exists` shows no `anon` or `PUBLIC` grant.
- Repo-wide search confirms `from('jobs').insert` no longer appears
  anywhere in `src/` -- `ScopeIntake.jsx` was the only caller.
- Live verification: a real job submitted through the intake wizard lands
  correctly via the RPC; a direct anon `insert` against `jobs` now fails
  RLS with no matching policy (see PR #14 for CI cross-tenant isolation
  results, and the follow-up live check noted in the PR).

## Follow-ups (not part of this fix, tracked separately)

- `jobs_select_company`: any authenticated employee (including plumbers)
  can currently `SELECT` all of their company's jobs, not just ones
  assigned to them. Same-company exposure only, not cross-tenant -- lower
  severity, deferred.
- Table-level grants on `anon`/`authenticated` are broader than they need
  to be (Supabase's default scaffold); RLS is the actual gate today, but
  tightening grants is defense-in-depth. Flagged in the 2026-08-06 audit
  as a recommended-not-yet-applied follow-up; still outstanding.
- Production schema still isn't deployed from migration files in this
  repo -- DDL is applied directly via the Supabase SQL editor and
  documented after the fact. `docs/migrations/*.sql` here is a record of
  what was run, not something CI applies.
