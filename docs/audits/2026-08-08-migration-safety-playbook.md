# Migration Safety Playbook — 2026-08-08

## Question this answers

Tier 1 item 7: the dispatcher dashboard is coming up next, and it will
almost certainly need new tables or columns (assigned jobs, dispatcher
notes, job status changes, maybe a `dispatchers` role distinction). That
means schema changes against the live production database, for the first
time since this project had real beta customers on it. What's the process
that makes sure one of those changes can't take the site down or lose
data, and what do you actually do differently next time versus just
writing `ALTER TABLE` in the SQL Editor and hitting Run?

## The one fact that shapes everything else here

A schema change is different from every other kind of change you've made
so far. A bad line of CSS makes a page look wrong. A bad schema change can
make the app **fail to start**, or worse, **silently corrupt or lose
data** — and unlike the CSS, you can't just `git revert` your way out of
it, because the data existed for real, in real rows, before the change
ran. Vercel's one-click rollback (which is genuinely enough safety net for
frontend deploys) does nothing for the database — the database doesn't
have a "previous deploy."

That's why this playbook exists as a separate thing from normal
development: schema changes get a slower, more deliberate process than
everything else, on purpose.

## Part 1 — the "expand‑contract" pattern

The failure mode this avoids: you need to rename a column, so you write
one migration that does `ALTER TABLE jobs RENAME COLUMN old_name TO
new_name`. The instant that runs, every part of the app that hasn't been
redeployed yet (Vercel's edge network doesn't swap every request to the
new code atomically) starts throwing errors, because it's still asking for
`old_name`, which no longer exists. Best case, a few requests fail for a
few seconds. Worst case, a write happens mid-deploy and data goes to
neither the old nor the new place correctly.

Expand-contract fixes this by never doing a change in one step:

1. **Expand** — add the new thing (new column, new table) alongside the
   old one. Nothing that currently exists is touched. The old code keeps
   working exactly as before, because nothing it depends on changed.
2. **Backfill** — copy/derive data from the old structure into the new
   one, for existing rows. Run this as its own step so it can be checked
   before anything depends on it being correct.
3. **Cutover** — deploy the application code that reads/writes the new
   structure instead of the old one. This is a normal Vercel deploy, not a
   database change, so the existing rollback safety net (one click, back
   to the last good deploy) fully applies to it.
4. **Contract** — only after step 3 has been live and confirmed working
   for a while (hours or days, not minutes), drop the old column/table in
   its own, separate migration.

The rule this produces: **never combine "add" and "remove" in the same
migration.** If a migration plan has a `DROP` or `RENAME` in it, that's a
sign it should be split into at least two migrations, run on two different
days.

## Part 2 — every migration ships with its rollback, written first

Before running anything against production, write the rollback for it —
the exact SQL that would undo this specific change if it turns out to be
wrong. If you can't write that rollback, or writing it makes you realize
"there's no clean way to undo this," that's the migration telling you it
isn't ready.

Template — fill this in for every real migration, save it in
`docs/migrations/` alongside the actual SQL:

```
## Migration: <short name>
Date:
Author:

### What this does
<plain-language description>

### Expand-contract stage
[ ] Expand   [ ] Backfill   [ ] Cutover   [ ] Contract
(most migrations are exactly one of these -- if this box-checking feels
like it wants two boxes checked, split it into two migrations instead)

### Forward SQL
```sql
-- the actual migration
```

### Rollback SQL
```sql
-- the exact commands that undo the forward SQL above, and nothing else
```

### How to verify it worked
<specific query or app behavior to check -- not "it looked fine">

### Tested on staging?
[ ] Yes -- ran on scope-staging first, forward AND rollback, both verified
```

A concrete worked example, using a plausible dispatcher-dashboard change
(nothing here has actually been decided yet — this is the template
exercised, not a real plan):

```sql
-- Forward (Expand): add assigned_employee_id to jobs, nullable so existing
-- rows aren't touched and old app code (which never sets this column)
-- keeps working unmodified.
alter table jobs
  add column assigned_employee_id uuid references employees(id);

-- Rollback: exact inverse.
alter table jobs
  drop column assigned_employee_id;
```

That's it for that migration. The follow-up "now make the dashboard
actually set and read this column" is an app code change + deploy, not a
second database migration. Only once that's live and working would a
*separate*, later migration ever consider e.g. making the column
`not null` (a Contract-stage change, and only if every row has been
backfilled with a real value first).

## Part 3 — the staging environment (built 2026-08-08)

Until today there was nowhere to run a migration except directly against
production. That's fixed now: there's a second, separate Supabase project,
**scope-staging**, whose only job is to be a safe place to run a migration
and its rollback before either ever touches real data.

**What it is:** a full copy of production's schema — every table,
column, function, RLS policy, index, trigger — with **zero customer
data** in it. No real job records, no real employee records, nothing a
plumbing customer ever typed. That's deliberate: staging is a lower-security
environment than production (fewer eyes on it, less hardened), so it
should never hold anything real.

**How it stays in sync:** a new GitHub Actions workflow,
`.github/workflows/sync-staging.yml`, does a schema-only `pg_dump` from
production and restores it into staging. It only runs when you trigger it
manually (Actions tab → "Sync staging schema from production" → Run
workflow) — never on a schedule, because syncing staging is a deliberate
step you take right before testing a migration, not a background job.

**The process for every future schema change:**

1. Run the sync-staging workflow so staging matches production's current
   shape.
2. Connect to staging's SQL Editor (Supabase dashboard → scope-staging
   project) and run the forward migration SQL from your migration doc.
3. Check it actually worked — run the "how to verify" query from the doc,
   and if it's a change the app touches, point a local/preview build at
   staging's connection string and click through the affected screens.
4. Run the rollback SQL against staging. Confirm staging is back to
   exactly its pre-migration shape (the sync-staging workflow's own
   verification step, which diffs staging's table list against
   production's, is a good sanity check to re-run here too).
5. Only after both forward and rollback are proven on staging, run the
   forward SQL against production for real.

If a migration can't be cleanly tested this way (e.g. it depends on data
volume or shapes staging doesn't have), that's a signal to seed staging
with representative fake data for that specific test — not a reason to
skip straight to production.

## Checklist before running anything against production

```
[ ] Migration is expand-only, OR contract-only, OR backfill-only --
    never a mix
[ ] Rollback SQL is written and saved, not just "I'll figure it out if
    something breaks"
[ ] Ran sync-staging, then ran forward + rollback against scope-staging,
    both verified
[ ] Have a specific query or app behavior in mind to confirm it worked in
    production, not just "no errors appeared"
[ ] If this is a Contract-stage change (dropping/renaming something),
    the Expand+Cutover stage has been live in production for a real
    stretch of time already, not just minutes
```
