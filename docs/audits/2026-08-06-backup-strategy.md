# Backup Strategy — 2026-08-06

## Question this answers

Tier 1 item 4: does Dante have any working backup of production data today,
and if not, what's the smallest thing that actually fixes that for a
pre-revenue, solo-founder project on Supabase's Free plan?

## The one fact that shapes everything else here

**No. There is currently no backup of production data, of any kind,
anywhere. If someone ran `DROP TABLE jobs` or a bad migration against
`etpzprrroxjjroisboui` right now, that data is gone, permanently, with no
recovery path.** This isn't a guess — checked directly against the live
dashboard (`Database > Backups`, both tabs) on 2026-08-06:

- **Scheduled backups tab:** "Free Plan does not include project backups.
  Upgrade to the Pro Plan for up to 7 days of scheduled backups."
- **Point in Time tab:** "Point in Time Recovery is a Pro Plan add-on ...
  Starts at $100/month."

Confirmed against Supabase's own docs too
(`supabase.com/docs/guides/platform/backups`, fetched 2026-08-06): *"We
automatically back up all Pro, Team, and Enterprise Plan projects on a
daily basis ... We recommend that free tier plan projects regularly export
their data using the Supabase CLI `db dump` command and maintain off-site
backups."* Free tier gets zero automated backup capability, full stop —
not a reduced version of it, none. Supabase is telling you, in their own
docs, that on Free you are responsible for this yourself. Nobody has been
doing that for this project until this commit.

For scale: today that's 1 company, 2 employees, 13 jobs — small enough
that losing it would be an annoyance, not a catastrophe, for Dante
personally. But the whole point of doing this now, per the playbook, is
that this is exactly the wrong time to find out you need it — do it before
the dataset (and the number of real customers depending on it) is big
enough that losing it is a genuine disaster.

## What Pro ($25/mo) buys you here, for context

- **Daily backups, 7-day retention**, included at no extra cost on Pro.
- **PITR (point-in-time recovery)** as an add-on on top of Pro, starting at
  $100/month for 7 days of second-granularity recovery, $200/mo for 14
  days, $400/mo for 28 days. This is a meaningfully different (better)
  capability than daily backups — it protects the hours between backups,
  not just whole days — but it's real money for a pre-revenue project, and
  daily backups (free-tier-compatible via this build) already close the
  actual gap that exists today: **currently zero backups of any kind.**
  Recommendation below is: build the free DIY daily-backup approach now,
  revisit Pro (or Pro + PITR) once there's revenue or a second real tenant
  to lose sleep over.

## Recommended strategy

**Frequency: daily.** The dataset is tiny and slow-moving today (13 jobs
total) — hourly would be overkill and there's no revenue on the line yet to
justify tighter RPO. Daily matches what Pro would give you anyway, and is
cheap enough in GitHub Actions minutes to run indefinitely. Revisit if job
volume picks up materially.

**Location: a separate, private GitHub repo, not this one.** This repo
(`Scope-Intake`) is **public**. That rules out committing dumps here, and
also rules out GitHub Actions artifacts on this repo — artifact downloads
from a public repo's workflow runs are reachable by any logged-in GitHub
user, and a dump contains real customer names, addresses, and emails. So:
a second, **private** repo (e.g. `scope-backups`), created and owned by
Dante, holding nothing but encrypted daily dump files. This is genuinely
separate infrastructure from Supabase — if the Supabase project or account
is ever deleted, compromised, or the whole company is offboarded, the
backups live somewhere else entirely, under separate credentials. It's
still "GitHub" as a platform, which is a fair objection if you want true
infra independence, but it satisfies the actual failure modes that matter
here (bad migration, accidental DROP, Supabase account issue, someone else
gaining access to the live DB) at zero dollars, which is the right
trade-off for this project's stage.

Every dump is also **symmetrically encrypted (AES256, via `gpg`) before it
ever leaves the GitHub Actions runner**, using a passphrase that lives only
in a GitHub Actions secret (and should also live in Dante's password
manager, separately — see setup steps below). This matters even though the
backups repo is private: defense in depth against that repo ever being
misconfigured to public, a collaborator being added later, or a leaked PAT
giving read access without the encryption key.

**Retention: 30 daily snapshots**, actively kept in the backups repo's
working tree; older ones remain recoverable from git history if ever
needed but drop out of the "current" file listing so the repo doesn't grow
without bound. 30 days is arbitrary but reasonable for a dataset this size
— cheap to keep even at 30x current volume, and comfortably covers "I
didn't notice the problem for a couple weeks," which is the realistic
failure mode for a solo founder, more so than "I need last Tuesday
specifically."

**What this does NOT give you:** point-in-time / sub-day recovery. Worst
case with daily backups, you lose up to ~24 hours of data in a disaster.
For a 13-job dataset today, that's acceptable. It will stop being
acceptable at some point — that's the trigger for upgrading to Pro (daily
backups built in) and/or the PITR add-on, not a reason to avoid building
the free version now.

## What was built

1. **`.github/workflows/supabase-backup.yml`** — scheduled GitHub Action,
   runs daily at 09:17 UTC (arbitrary off-peak time) plus supports manual
   trigger (`workflow_dispatch`) from the Actions tab. Steps:
   - Fails fast with a clear error if any of the four required secrets
     (below) aren't set, rather than silently no-op'ing.
   - Installs `postgresql-client` on the runner.
   - Runs `pg_dump "$SUPABASE_DB_URL" -Fc --no-owner --no-privileges` —
     custom-format (compressed, selectively restorable), against the
     direct Postgres connection string, not the Supabase CLI (fewer moving
     parts, no CLI auth flow to maintain).
   - Sanity-checks the dump size (rejects anything under 2KB — a real
     empty/near-empty dump almost always means the connection string was
     wrong, and `pg_dump` can exit 0 in that case) and runs `pg_restore
     --list` against the dump to confirm it parses and that the six known
     production tables (`companies`, `employees`, `jobs`, `invite_codes`,
     `ai_usage_log`, `billing_guardrails`) are actually present in the
     table of contents, all without needing a live database — this catches
     a truncated/corrupt dump before it's ever shipped anywhere.
   - Encrypts with `gpg --symmetric --cipher-algo AES256`, deletes the
     plaintext dump immediately after.
   - Clones the private backups repo, adds the encrypted file under
     `daily/scope-YYYY-MM-DD.dump.gpg`, prunes to the newest 30 files,
     commits, and pushes.

2. **`scripts/restore-backup.sh`** — decrypts a `.dump.gpg` file and
   restores it into a target Postgres connection string you supply
   explicitly (never defaults to production, never auto-detects a target —
   you have to hand it one). Validates the dump structure with `pg_restore
   --list` before touching any database, prompts for an explicit `yes`
   confirmation before restoring, and prints a follow-up row-count sanity
   check command. Used for both the routine restore drill and real
   disaster recovery (see below).

## Exact setup steps Dante needs to do (nothing here was run automatically — no credentials were available to do it as this agent, and the credential should never be typed anywhere insecure)

1. **Create a new private GitHub repo** for backups — e.g.
   `floridaman504/scope-backups`. Empty is fine, the Action populates it.
   Keep it **private**.
2. **Create a fine-grained GitHub PAT** scoped only to that one repo:
   GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → generate one, repository access limited to
   `scope-backups` only, permission `Contents: Read and write`. Nothing
   broader — this token should not be able to touch `Scope-Intake` or any
   other repo.
3. **Get the Supabase direct Postgres connection string**: Supabase
   dashboard → this project → Project Settings → Database → Connection
   string → URI tab. This is effectively your database root password —
   handle it like one.
4. **Generate an encryption passphrase**: anything long and random works,
   e.g. run `openssl rand -base64 32` locally. Save this in your password
   manager — if it's lost, every existing backup becomes permanently
   unreadable, there's no recovery on the encryption itself.
5. **Add four repository secrets** in `Scope-Intake` → Settings → Secrets
   and variables → Actions → New repository secret:
   - `SUPABASE_DB_URL` — the connection string from step 3
   - `BACKUP_REPO` — e.g. `floridaman504/scope-backups`
   - `BACKUP_REPO_TOKEN` — the PAT from step 2
   - `BACKUP_ENCRYPTION_PASSPHRASE` — the passphrase from step 4
6. **Trigger one manual run** to confirm it works: Actions tab → "Supabase
   daily backup" → Run workflow. Confirm a new commit lands in
   `scope-backups/daily/`.

None of this requires Dante to pay for anything new — GitHub private repos
and Actions minutes are free at this usage level (one job, a few minutes,
once a day).

## Restore test plan

### What I actually validated (this session, no production access)

I don't have production credentials (by design — this task explicitly
withheld them), so I couldn't dump real prod data. Instead I reconstructed
a representative schema from the two prior Tier 1 audit docs (all six
known production tables, plus the pending `session_policy`/`user_sessions`
tables from Tier 1.3) and seeded it with fake data at the same scale as
real production (1 company, 2 employees, 13 jobs), using a real local
PostgreSQL 16.2 instance. I then ran the **actual, unmodified**
`pg_dump` → `gpg encrypt` → drop-source-entirely → `scripts/restore-backup.sh`
→ `pg_restore` chain — the identical commands the GitHub Action and restore
script use, not a simulation of them — against that instance:

```
source counts before backup:      billing_guardrails=1, companies=1,
                                   employees=2, invite_codes=1, jobs=13,
                                   session_policy=3
[dropped the source database entirely to simulate real data loss]
restored counts after restore:    billing_guardrails=1, companies=1,
                                   employees=2, invite_codes=1, jobs=13,
                                   session_policy=3   -- exact match
```

All 8 tables present post-restore, spot-checked row contents (`jobs.customer_name`,
`jobs.status`) matched the seed data exactly. The `scripts/restore-backup.sh`
script itself — not just the underlying `pg_dump`/`pg_restore` calls — was
what ran, including its confirmation prompt and `pg_restore --list`
structure check.

**What this proves:** the mechanics (dump format, encryption/decryption,
restore command, script logic) work correctly end to end. **What this
doesn't prove:** that `SUPABASE_DB_URL` as Dante will configure it actually
has network access and permissions to run `pg_dump` against the real
project from a GitHub Actions runner — that can only be confirmed by
actually running the workflow once the secrets are set (step 6 above), and
by an occasional real restore drill against a throwaway target.

### Ongoing restore drill (recommended: monthly, or after any schema change)

1. Pick a recent file from `scope-backups/daily/`.
2. Spin up a disposable local Postgres (Docker is the easiest way if
   available: `docker run --rm -e POSTGRES_PASSWORD=postgres -p
   5432:5432 postgres:16`).
3. `export BACKUP_ENCRYPTION_PASSPHRASE='...'` (same value as the GitHub
   secret, from your password manager).
4. `createdb -h localhost -U postgres scope_restore_test`
5. `./scripts/restore-backup.sh scope-YYYY-MM-DD.dump.gpg
   "postgresql://postgres:postgres@localhost:5432/scope_restore_test"`
6. Confirm the prompt, let it restore, then sanity-check:
   `psql "postgresql://postgres:postgres@localhost:5432/scope_restore_test" -c
   "select count(*) from jobs;"` and compare against what you'd expect from
   the live dashboard. Tear the container down when done — nothing here
   touches production.

### Real disaster recovery (if it's ever actually needed)

1. Create a fresh, empty Supabase project (dashboard → New project).
2. Get its Postgres connection string (Settings → Database → Connection
   string).
3. Run `./scripts/restore-backup.sh <latest-dump.gpg> "<new-project-connection-string>"`.
4. Re-apply RLS policies and any `SECURITY DEFINER` functions — **`pg_dump`
   of the public schema captures policies and functions that exist in that
   schema, so a full-schema dump should bring them back, but confirm this
   explicitly post-restore** by re-running the read-only introspection
   queries from `docs/audits/2026-08-06-cross-tenant-isolation-audit.md`
   (the `pg_policies` / `rowsecurity` checks) against the restored project
   before pointing the live app at it. Don't assume — verify.
5. Update `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in Vercel project
   settings to point at the new project, redeploy.

## Honest limits of this design

- **Daily granularity, not PITR.** Up to ~24 hours of data loss in the
  worst case. Acceptable at today's scale; revisit at Pro + PITR once
  there's real revenue/customers to protect more tightly.
- **This workflow has not yet run against real production** — it can't,
  without the `SUPABASE_DB_URL` secret Dante has to add himself. Until
  step 6 in the setup steps happens, this is a correct, tested mechanism
  that has never touched the real database. Don't consider Tier 1.4
  "done-done" until that first real run is confirmed green in the Actions
  tab.
- **Storage-API objects aren't included.** Like Supabase's own backups,
  `pg_dump` captures database rows, not files stored via the Supabase
  Storage API (this project doesn't appear to use Storage today based on
  the schema in the prior audits, but flagging it in case that changes).
- **Custom role passwords aren't captured**, matching Supabase's own daily
  backups behavior — not relevant today since this project doesn't appear
  to use custom Postgres roles beyond the Supabase defaults, but worth
  knowing if that changes.
- **The backups repo PAT and encryption passphrase are both single points
  of failure for restoring**, by design (that's what makes them useful as
  access control) — which also means if Dante loses both, backups become
  unusable. Recommendation in the setup steps above to keep the passphrase
  in a password manager, separate from GitHub, stands.
- **git-repo-as-backup-store doesn't scale forever.** Fine for years at
  this data volume (dumps are currently ~15KB uncompressed, sub-4KB
  encrypted); if the dataset grows by orders of magnitude, revisit in
  favor of object storage (S3/R2/B2) rather than a growing git history.
  Not a concern today.
