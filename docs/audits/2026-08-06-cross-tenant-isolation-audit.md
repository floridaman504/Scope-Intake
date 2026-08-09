# Cross-Tenant Isolation Audit — 2026-08-06

## Question this answers
Is the live production Supabase project (`scope`, project ref
`etpzprrroxjjroisboui`) actually multi-tenant, or is `main`'s single-tenant
git history the real state of the world? Checked directly against
production via the Supabase SQL editor (read-only introspection queries
only — no data was modified).

## Result: production is multi-tenant and RLS is correctly enforced

**Tables** (`public` schema): `companies`, `employees`, `jobs`,
`invite_codes`, `ai_usage_log`, `billing_guardrails`. All six have
`company_id` (except `companies` itself, which is the tenant root) and all
six have Row Level Security **enabled** (`rowsecurity = true`).

**Policies** (7 total, `pg_policies`):

| Table | Policy | Command | Scope |
|---|---|---|---|
| ai_usage_log | ai_usage_select_company | SELECT | `company_id = get_my_company_id()` |
| employees | employees_select_company | SELECT | `company_id = get_my_company_id()` |
| invite_codes | owners_create_own_company_invite_codes | INSERT | company-scoped + `get_my_role() = 'owner'` |
| invite_codes | owners_select_own_company_invite_codes | SELECT | company-scoped + owner only |
| jobs | jobs_select_company | SELECT | `company_id = get_my_company_id()` |
| jobs | jobs_update_owner_dispatcher_company | UPDATE | company-scoped, owner/dispatcher only |
| jobs | jobs_delete_owner_company | DELETE | company-scoped, **owner only** — matches the Owner-only permanent delete requirement |

`companies` and `billing_guardrails` have **no policies at all**, which
with RLS enabled means default-deny for every role, including
`authenticated` — correct, since the only sanctioned read path for company
info is the `get_company_by_subdomain()` function (see below).

**Security-definer functions confirmed present and pinned**
(`get_my_company_id`, `get_my_role`, `get_company_by_subdomain`,
`submit_public_job`, `redeem_invite_code`) — all have `SET search_path TO
'public'`, which prevents a search-path hijack from smuggling in a
malicious function of the same name. `submit_public_job` resolves the
company server-side from the subdomain, so the public intake form can
never be tricked into writing a job under a different company's ID.

**Data check:** 1 company, 2 employees, 13 jobs, 0 rows with a null
`company_id` anywhere. So the schema is correctly enforced today, but —
important caveat — **there is currently only one real tenant in
production.** Every policy above has been checked for correctness by
reading the SQL, but has never been exercised end-to-end against a second,
real competing tenant. "The policy text is correct" and "I watched Tenant A
fail to see Tenant B's data" are different levels of confidence, and right
now we only have the first.

## Gap: this isn't in `main`'s git history at all

None of this — not the `companies` table, not a single RLS policy, not
`get_my_company_id()` — exists in any commit on `main`. It was applied
directly against production via the Supabase SQL editor at some point,
separately from both tracked branches. `scopwell-preview` has migration
*files* that describe very similar (in some cases identical) DDL, but
production doesn't match either branch exactly — `billing_guardrails`, for
instance, isn't in any migration file on either branch.

**Practical effect: your Supabase schema is currently undocumented in version
control.** If the project were lost, or you needed to stand up a staging
copy, or another engineer joined, there's no single source of truth to
rebuild it from. Recommend a follow-up (this can be Tier 1 or Tier 2,
your call): pull the live schema with `supabase db dump --schema public`
and commit it, so the repo and production stop disagreeing about what
exists.

## Real finding: table-level grants are broader than necessary

`anon` and `authenticated` both hold `DELETE`, `INSERT`, `REFERENCES`,
`SELECT`, `TRIGGER`, `TRUNCATE`, `UPDATE` on every table (Supabase's
default scaffold — this is not something particular to your setup, every
fresh Supabase project starts this way). Because RLS is enabled with no
matching policy for most of those combinations, the *effective* access is
still default-deny — this isn't independently exploitable through the
normal Supabase REST API today.

Two reasons to still tighten it: (1) `TRUNCATE` bypasses row-level security
entirely — RLS only filters row-level SELECT/INSERT/UPDATE/DELETE, not
whole-table TRUNCATE. PostgREST doesn't expose a way to issue TRUNCATE
today, so this isn't currently reachable, but it's one Postgres feature
change or misconfigured RPC away from being reachable, and it costs
nothing to remove now. (2) if any future RPC function is written with
`SECURITY INVOKER` instead of `SECURITY DEFINER` and forgets to check
role, table-level grants become the only remaining backstop — better for
that backstop to already be minimal. Recommended fix (not yet applied,
needs your go-ahead since it's a production DDL change):

```sql
revoke truncate, trigger, references, delete, update, insert on all tables in schema public from anon;
revoke truncate, trigger, references on all tables in schema public from authenticated;
-- re-grant only what each table's policies actually use, e.g.:
-- grant select on employees, jobs, ai_usage_log to authenticated;
-- grant select, insert on invite_codes to authenticated; -- covered by policy anyway
```

## Not yet done: the behavioral cross-tenant test

The playbook calls for an automated test that logs in as Tenant A, loads
every page, logs in as Tenant B, and flags any Tenant A data appearing in
Tenant B's session. I did not fabricate a second company/tenant in
**production** to run this by hand — creating test companies/employees
directly in your live database isn't something I'll do without you saying
so explicitly, separate from the five Tier 1 items you already approved.

Two ways to get this test built (your call):
1. **In production, with immediate cleanup** — I create a second throwaway
   company + employee, run the cross-tenant checks, then delete every row
   I created (I'd show you the exact delete statements before running
   them).
2. **Proper isolated environment** — set up a Supabase branch (Supabase
   supports DB branching for preview environments) or point the test
   suite at a local/throwaway Supabase instance, so this test can also run
   in CI on every future change instead of being a one-time manual check.
   This is the better long-term answer and overlaps with Tier 1.5 (test
   suite) — worth doing them together.

### Resolved — 2026-08-09 (task #23)

Went with option 2. `scripts/cross-tenant-isolation-test.mjs` connects
directly to `scope-staging` and, inside a single transaction it always
rolls back, creates two throwaway companies (owner + dispatcher for
Tenant A, owner for Tenant B, two jobs each, an invite code and an
ai_usage_log row each). For each simulated user it does exactly what
PostgREST does per request — `SET LOCAL ROLE authenticated` (or `anon`)
plus `SET LOCAL request.jwt.claim.sub = '<uuid>'`, which is what
`auth.uid()` reads — so it's exercising the real policies from
`docs/schema/production-schema-2026-08-09.sql`, not a re-implementation of
them. Checks cover: Tenant A can't SELECT, UPDATE, or DELETE Tenant B's
jobs/employees/invite_codes/ai_usage_log; a dispatcher can UPDATE but not
DELETE their own company's job (role-scoped policy, not just
company-scoped); the symmetric check from Tenant B's side; anon can INSERT
via the public intake form but can't read anything back; and that
`companies` stays deny-all for both roles per the zero-policies design
above.

Runs as `.github/workflows/cross-tenant-isolation-test.yml` on every push,
every PR, and on demand. While building it, discovered that
`sync-staging.yml`'s `--no-privileges` pg_dump flag strips ALL grants on
every sync, not just table-level ones — `scope-staging` had lost
`USAGE ON SCHEMA public` for `anon`/`authenticated` entirely, which fails
as "relation does not exist" rather than a permissions error. Fixed by
adding a "reapply grants" step to `sync-staging.yml` itself, so every
future sync leaves staging privilege-accurate (matching production's
task #22 minimal grants), not just shape-accurate — otherwise this test
would have silently started failing the next time someone ran that
workflow.
