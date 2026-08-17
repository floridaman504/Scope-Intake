# API security & design audit, plus versioning

Tier 2 #12 of `docs/scope-operational-playbook.md`, "API Security &
Versioning." This app's entire backend API surface is two Vercel
serverless functions -- everything else the app does talks to Supabase
directly (PostgREST + RLS, audited separately in the cross-tenant
isolation and session-hardening work). So "audit every endpoint" here is
a short, complete list, not a sample.

## The audit: both endpoints, in full

### `POST /api/review-job` (now `/api/v1/review-job`)

**What it does:** takes a customer's public job-intake submission and
calls Anthropic to produce a short AI job brief for the plumber, before
the job is saved.

**Returned fields:** `jobType`, `urgency`, `likelyMaterials`,
`briefSummary`, `watchOutFor` -- five short AI-generated strings/arrays.
Nothing else. No customer PII is echoed back (the request contains the
customer's name/phone/email, but the response never includes them), no
internal IDs, no other customer's data, no database row of any kind.
**Not over-exposed.**

**Sequential ID usage:** none. This endpoint runs *before* a job exists
-- it returns an AI classification, not a database row -- so there's no
ID in play at all here. (The job itself, created afterward by
`submit_public_job()`, gets a `gen_random_uuid()` id -- unguessable by
design, same as every other row this app hands back to an
unauthenticated client.)

**Auth:** none, and that's intentional, not a gap. A customer hasn't
signed up for anything when they hit this -- there's no session to
require. The real risk of no auth on a public endpoint that calls a paid
third-party API is unbounded cost from abuse, and that's already closed:
input length caps (reject >6000 chars rather than silently truncate),
per-IP and per-company rate limiting via `check_rate_limit()`, and a
global daily cost cap, all added in earlier passes (see
`docs/audits/2026-08-16-ddos-rate-limiting.md`). Every error path already
returns a safe, generic message -- never a raw Anthropic or Supabase
error string (`docs/audits/2026-08-16-error-handling.md`).

### `POST /api/check-missed-leads` (now `/api/v1/check-missed-leads`)

**What it does:** a scheduled job (GitHub Actions, every 10 minutes)
that finds jobs unclaimed for over an hour and emails the company's
owner/dispatcher.

**Returned fields:** `{ checked, alerted, failed, failures: [{ jobId,
status }] }` -- counts, plus job ids and HTTP status codes for anything
that failed. This does include real job ids in the response body.

**Sequential ID usage:** none -- `jobId` here is the same
`gen_random_uuid()` job id as everywhere else, not a sequential integer.

**Auth:** required and enforced -- every request must carry
`x-cron-secret` matching the `CRON_SECRET` environment variable, checked
before any database access happens; a missing or wrong secret gets a
401 with no further processing. **This is why returning job ids in the
response body is fine here but wouldn't be on a public endpoint:** this
route is not public. Only someone holding the secret (the GitHub Actions
workflow, using a repo secret) can ever see that response. Also uses the
Supabase **service role** key server-side only -- never sent to a
browser, never in this repo, set only in Vercel's project settings.

## What this audit did *not* find

No missing auth on anything that should have it, no endpoint returning
more than it needs to, no sequential/enumerable IDs anywhere in this
app's API surface. The two real risk factors this audit did confirm are
already-closed gaps from earlier passes (cost/rate limiting on the
public endpoint, safe error messages everywhere) -- see the audits
linked above. Nothing new to fix here beyond the versioning below.

## Versioning: `/v1/` prefix

Both endpoints moved from `api/*.js` to `api/v1/*.js` -- Vercel builds
routes directly from the file path, so this alone is the entire
versioning mechanism; no router or config needed. `api/_lib/` (the
shared safe-error/logging helper) stays unversioned since it's internal
implementation, not part of the public route surface.

**What "v1" means going forward, in practice:** a change that removes a
field, changes a field's type/meaning, or changes what a request needs
to succeed is a breaking change and gets a new `/v2/` route living
alongside `/v1/` rather than silently changing behavior underneath
whoever's already calling it. An additive change (a new optional field,
a new endpoint) stays within v1 and gets a changelog entry. See
`docs/api/changelog.md`.

**Honest scoping note on the cutover itself:** this app has exactly two
callers of its own API today -- the intake form in this same codebase,
and the GitHub Actions workflow that calls the missed-lead check. There
are no external/partner integrations yet. Because of that, this shipped
as a straight cutover (old paths simply stop existing) rather than
building a redirect/dual-routing layer for paths nobody outside this app
calls. The one real edge case: GitHub Actions reads the workflow file
fresh from `main` on every scheduled run, but Vercel's production
deployment swap can lag a merge by a minute or two. In that narrow
window, a scheduled run could hit `/api/v1/check-missed-leads` on a
still-deploying old build and get a 404. The job runs every 10 minutes
and is fully self-healing (an unclaimed job just gets picked up on the
next successful run) -- not worth a dual-routing layer for a
worst-case single missed cycle on a non-customer-facing internal cron.
If Scope ever adds a real external API consumer, this tradeoff should be
revisited before that consumer's first breaking change.

## Documentation

`docs/api/v1.md` -- a full reference for both v1 endpoints: method,
path, auth requirement, request shape, response shape, error codes.
`docs/api/changelog.md` -- the versioning policy above, plus this
release as changelog entry one.

**Scoping note on "public documentation page":** the playbook item asks
for a public documentation page, which reads as written for a product
with outside developers integrating against it. Scope doesn't have that
today -- no partner or customer ever calls this API directly. Building a
live hosted docs site for zero external readers would be exactly the
kind of premature infrastructure earlier audits in this series
deliberately scoped out (see the Cloudflare WAF call in
`docs/audits/2026-08-16-ddos-rate-limiting.md`, and the Playwright call
in `docs/audits/2026-08-16-error-boundary-and-logging.md`). Instead, the
documentation is written in full now, version-controlled, and ready to
publish as an actual hosted page the moment there's a real external
consumer to publish it for.

## What shipped alongside this, unrelated to versioning

`src/Join.test.jsx` had one stale assertion left over from the last PR
(`docs/audits/2026-08-16-error-boundary-and-logging.md`): it asserted
"no RPC call happened at all" on a signup failure, which broke the
moment that PR made `logSafeError` fire its own durable
`log_app_error` RPC call in the background. The test's actual intent
was "the invite code wasn't redeemed," so it now checks specifically for
that instead of a blanket zero-calls assertion. Caught by running the
full suite before starting this work, not by the previous PR's own test
run (a fire-and-forget background call from a shared helper touched a
test file well outside anything that PR's diff appeared to change).

## Verification

Full test suite (176 tests, all passing, including the one fixed above)
and a production build both run clean. Confirmed via `grep` across the
whole repo (source, workflows, and docs, excluding the historical audit
docs which correctly describe the paths as they were at the time) that
no code path still references the old unversioned URLs -- the frontend
intake form, the GitHub Actions cron workflow, and the Error Log page's
UI all point at `/api/v1/...` now.
