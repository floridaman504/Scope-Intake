# Error handling, part 2 -- catching every failure and actually keeping a record

## Where this picks up

An earlier pass (`docs/audits/2026-08-16-error-handling.md`) already fixed
the "don't show customers a raw database error" problem across 21 places
in the app. That was step one of a three-part playbook item (Tier 2 #10,
"Error Handling Rebuild"). This closes the other two: making sure nothing
in the app can fail *without* being caught somewhere, and making sure
every real failure lands somewhere a person can actually go look at it
later -- which, until now, wasn't true anywhere in this app.

## The gap, in plain terms

Every place that already caught an error was doing the right first
half -- showing a safe, friendly message instead of a scary technical one.
But the *real* error, the one a person would actually need to diagnose
what went wrong, only ever went to a console: the browser's own console
(only visible to whoever happens to have their browser's developer tools
open at that exact moment) or Vercel's server logs (not part of this
app, and short-lived on Vercel's free tier). Nobody was ever coming back
to look at either one.

The clearest real example: the missed-lead email job already tracks its
own failures internally -- if Resend (the email provider) starts
rejecting every send, that job knows it and counts it as a failure. But
that count only ever showed up in a JSON response that a scheduled robot
reads and throws away. If that exact failure pattern happened again (it
has before -- see that file's own bugfix comment), nobody would find out
until a customer complained that a job sat unclaimed for hours.

## What this closes: every place that can fail, now catches and keeps a record

Went through the app boundary by boundary -- every place where something
outside this app's control (a database call, a network request, a
third-party API, a browser rendering error) could fail:

**The two API routes** (`api/review-job.js`, the public AI review step,
and `api/check-missed-leads.js`, the scheduled missed-lead job) already
had a catch-all try/catch from the earlier pass. Both now also write the
real failure to a permanent record, not just a console.

**The missed-lead job's two handled-but-silent failure points** -- an
email that failed to send, and a job that got emailed but couldn't be
marked as handled -- now also get written to that same record, even
though the job itself already recovers from both automatically (the next
run retries). Worth knowing about if it keeps happening, even though
nothing broke outright.

**Every screen in the logged-in app** (dispatcher, owner, and plumber
views, plus the public sign-up/password-reset pages) already routes
through one shared helper for anything that fails -- same one-line change
as before, now also keeping a record.

**A React rendering crash anywhere in the app** -- the safety net that
shows "Something Went Wrong" instead of a blank white page -- sits at the
very top of the whole app, above every single page, so there is no screen
that can crash without it catching things. It now also keeps a record.

**What doesn't apply yet, on purpose:** the playbook also calls out
webhook receivers and payment callbacks. Neither exists in this app --
there's no billing integration yet (see
`docs/audits/2026-08-16-billing-readiness-plan.md`). Nothing to cover
until that gets built; noting it here so it doesn't read as a missed spot.

## The permanent record: a new Error Log, for owners only

`docs/migrations/2026-08-16-error-log-pipeline.sql` adds a new place
these failures land -- a table only an owner can read, with a page in the
app (**Error Log**, next to Audit Log on the dashboard) to actually look
through it: filterable by how bad it was (error/warning/info), by which
part of the app it happened in, and by how far back to look (24 hours up
to 90 days).

Each entry keeps the same safe message a customer or employee would have
seen, plus (for owners only) the real underlying detail -- the actual
error and, where useful, a stack trace -- so there's enough to actually
diagnose something instead of just knowing it happened.

**Kept for 90 days, the playbook's floor.** After that, entries are
deleted automatically by a small daily step added to the backup job that
already runs every night -- same credential, no new setup needed.

**This new table is itself protected the same way the job-submission
limiter from the previous PR was:** it can only be written through one
narrow, rate-limited path (so nobody can flood it with fake entries),
and only an owner can ever read what's in it -- not a dispatcher, not a
plumber, and never a customer.

## Testing note: unit tests, not a new browser-automation framework

The playbook mentions Playwright for "intentional failure scenario"
testing. This app doesn't have Playwright set up, and this PR doesn't add
it. Every boundary covered here already has a direct unit test that
simulates the real failure (a rejected network call, a thrown error, a
failed database write) and confirms both halves: the safe message still
shows, and the real detail still gets logged. That's the same kind of
"intentional failure scenario" coverage the playbook is asking for --
Playwright would add browser-driven end-to-end tests on top of that,
which is a real but separate investment with no concrete need behind it
yet. Worth adding if this app grows enough real user-facing flows that
unit-level mocking stops being enough to trust a release.

## Verification

Migration tested against a real local Postgres: confirmed a logged-in
owner's entries resolve their employee/company automatically, confirmed
the per-IP rate limit silently stops accepting entries past the limit
(never breaks whatever was failing in the first place), confirmed a
non-owner employee sees zero rows through Row Level Security, and
confirmed the 90-day cleanup function and the rollback both work cleanly.

Every new and touched call site has a direct test confirming it now logs
to the new table with the right details. Full test suite (168 tests, 15
new) and a production build both run clean.
