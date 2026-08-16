# Self-service email change (follow-on from the audit-trail item)

## The problem, in plain terms

While building the audit trail (Tier 2 #9.5), it came up that this app had no
way for someone to change the email address on their own account at all --
so "email changed" was a checklist category with nothing behind it to log.
Same situation as the role-editing gap: not something the audit-trail work
created, just something it surfaced. This closes it by building the actual
feature, with the audit-log entry as part of it from day one.

## The fix -- two steps, on purpose

Changing an email safely needs two things to both be true: the person has to
prove they control the new address (so nobody can quietly redirect your
account to an inbox they own), and the change has to show up everywhere the
app displays or uses that email today (the Team page, job assignment, the
audit log itself).

**Step 1 -- prove it.** A new "Change email" link on the dashboard opens a
one-field form. Submitting it asks Supabase (the login/account system this
app is built on) to email a confirmation link to the *new* address. Nothing
changes yet at this point -- if that link never gets clicked, the account
just keeps working exactly as before, on the old email.

**Step 2 -- sync it.** Clicking the link in that email confirms the change
on Supabase's side and lands the person back on a new page in the app,
which copies the now-confirmed email onto their profile record here (the
copy the Team page, job assignments, and the audit log all actually read
from day to day). This is a narrow, one-purpose database function that can
only ever copy in what Supabase itself already confirmed for that exact
signed-in person -- it has no way to be tricked into setting someone's
email to something unconfirmed.

Every employee can change their own email this way (not owner-only, unlike
role editing or deactivation -- this is a personal account setting, same
category as changing your own password already was).

## What gets logged

The moment the sync in step 2 happens, it's recorded in the audit log
(`employee_email_changed`, with the old and new address) the same way a
role change or deactivation is -- visible to owners on the Audit Log page
from PR #34.

## Database changes

One new migration, `docs/migrations/2026-08-16-employee-email-change.sql`:
- A new function, `sync_my_email()`, that a signed-in person can call to
  pull their own already-confirmed email in from Supabase and update their
  profile record with it.
- An update to the audit-trail migration's logging function (PR #34) adding
  the one new case: log an entry when a profile's email actually changes.
  Written as a new file rather than editing PR #34's file in place, since
  that PR is still open -- matches how this repo has always layered
  database changes rather than rewriting history.

A rollback file is included and was tested to cleanly undo both pieces
without touching the role/deactivation logging PR #34 already put in place.

## Verification

Tested against a real local Postgres database before writing any app code:
applied the migration, simulated a full email change end to end (confirmed
the profile record updates, exactly one audit log entry is written with the
correct before/after addresses, and calling the sync function again with
nothing changed doesn't write a duplicate entry), then ran the rollback and
confirmed everything reverts cleanly with the older behavior (role and
deactivation logging) still intact.

Full test suite (147 tests, 7 new) and a production build both run clean.
