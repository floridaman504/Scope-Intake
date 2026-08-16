# Sensitive-action audit trail (Tier 2, item #9.5 of docs/scope-operational-playbook.md)

## The problem, in plain terms

Before this, there was no record anywhere of *who* deactivated an employee,
*who* deleted a job, or *when* someone reset their password. The app would
do the thing, but there was no paper trail afterward -- if a customer ever
disputes "I never asked for that job to be deleted" or a deactivated
employee claims it was a mistake, there was nothing to point to. The
playbook item asks for this specifically: "for every action that modifies
permissions, billing, email, password, or deletes data, log who/when/from
what IP/what changed."

## What actually gets logged

Checked what real code paths exist today for each category the playbook
listed, rather than guessing:

- **Permissions (role)** -- covered two ways. Every new employee getting a
  role assigned at sign-up (there's no other way to get a role today) logs
  an entry. So does an in-place role *change*, even though no such button
  exists in the app yet -- that's future-proofing so a role-edit screen
  added later doesn't silently ship without a log entry. Deactivating or
  reactivating someone is logged too, since that's just as much of an
  access-control change as the role itself.
- **Billing** -- checked, and nothing in this app ever changes billing
  today (the company's plan is never written by any code path). Nothing to
  log yet -- called out here rather than silently skipped, so it's not
  mistaken for an oversight.
- **Email** -- same story. There's no "change my email" screen anywhere in
  the app today. Nothing to log yet.
- **Password** -- covered. Every password reset is logged, attributed to
  whoever actually reset it.
- **Deletes data** -- covered. Deleting a job (the only permanent delete
  anywhere in this app) is logged.

## How it's tamper-resistant, not just a checkbox

The log entries are written by the database itself, not by this app's
code. Deactivating an employee, changing a role, or deleting a job all fire
automatically the instant the underlying database row changes -- there's no
way to do any of those three things, through this app's screens or any
other tool that touches the database directly, without a log entry being
created. Password resets are the one exception (Supabase's own login
system owns that data, not this app's database), so that one is a single
narrow function the app calls right after the password change succeeds,
locked down so it can only ever log an entry about whoever is calling it --
nobody can use it to fake an entry about someone else.

Nobody -- including the owner -- can edit or delete an entry once it's
written. Only the owner can *read* the log for their own company; every
other role sees nothing.

## What's on each entry

Who did it, what they did, what it was done to, when, and (best-effort,
same technique already used for session-login records) what IP address the
request came from. A short plain-language reason is included where it's
useful (e.g. a role change shows the old and new role).

## New owner-only page

`/audit-log`, linked from the dashboard and from the Team page. Shows the
most recent 200 entries, newest first.

## Verification

The migration and its rollback were both run against a real local
Postgres, not just eyeballed -- a throwaway database was built with the
same shape as the real one (companies/employees/jobs plus the two
permission functions everything else in this schema keys off), and every
logged action was actually triggered and confirmed to write the right row
with the right person attributed: a new employee joining, a deactivation,
a reactivation, an in-place role change, a job deletion, and a password
reset (confirmed attributed to the person resetting their own password,
not whoever else happened to be logged in). The rollback was then run and
confirmed to remove everything cleanly with no leftover triggers or
functions.

Full test suite (146 tests, 7 new) and a production build both run clean.
