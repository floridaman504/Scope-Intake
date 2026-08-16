# DDoS / abuse protection -- what's in place, and what to do if traffic looks wrong

## Why this is scoped the way it is

The operational playbook's item #11 is written as a generic checklist for
a much bigger company -- it references Cloudflare/AWS WAF configuration,
adaptive IP-banning middleware, and a formal incident runbook with a
notification chain. That's the right list for a company running its own
servers with a security team. Scope runs entirely on Vercel and Supabase,
which changes what actually needs to be built here versus what those
platforms already handle automatically. This document covers both: what's
already true today, what this session added, and what a real "traffic
looks wrong" moment actually looks like for this app -- so it's an honest,
usable runbook instead of a checklist item marked done against the wrong
stack.

## What's already true today, with no configuration needed

**Vercel absorbs large traffic spikes automatically.** Every request to
this app -- the site itself and the two API functions -- passes through
Vercel's edge network before it ever reaches application code. Sudden
volumetric floods (the kind a basic DDoS throws) are largely filtered
there, before they cost anything or affect real visitors. This is part of
every Vercel deployment, not a paid add-on that needs to be turned on.

**Supabase's database connection layer has its own limits.** Postgres
itself caps concurrent connections and Supabase's pooler queues/rejects
excess ones rather than letting the database fall over. Also automatic,
also already in effect.

**Login attempts are already locked out.** `login_attempts`
(`docs/migrations/2026-08-08-login-lockout.sql`, wired into `Login.jsx`)
tracks failed sign-ins per email and locks an account out temporarily
after repeated failures -- so credential-guessing against a real
employee's login is already blocked, independent of anything below.

**The AI review endpoint already had cost/abuse limits.** `api/review-job.js`
calls `check_rate_limit()` before every call to the AI provider, capping
requests per IP per hour, per company per day, and a global daily dollar
cap across the whole app (`billing_guardrails`). This existed before this
session -- it's the reason a bot hammering the "review my job" step can't
run up real money.

## What this session added

**The public job-intake write had no limit at all.** `submit_public_job()`
is the function that actually saves a job to the database. It's callable
directly through Supabase's API by anyone holding the app's public key --
which is, by design, visible in the browser, the same way it is for every
Supabase app. Until now, nothing capped how many jobs a single source
could create this way, even bypassing the intake form and the AI step
entirely. Not a money risk (no paid API call happens here), but a real
one: a bot in a loop could flood a company's job queue with junk requests,
burying the real ones from actual customers.

`docs/migrations/2026-08-16-job-submission-rate-limit.sql` closes that,
mirroring the exact same pattern already proven on the AI endpoint: at
most 10 job submissions per hour from one IP address, at most 200 per day
company-wide, both comfortably above anything a real plumbing company's
public intake form would ever legitimately see in a day. A customer will
never notice this exists. A bot in a loop will hit it within minutes.

## What was deliberately not built, and why

A dedicated WAF product (Cloudflare or similar) is not connected, and
isn't recommended at this stage. It's a real tool for a company already
seeing attack traffic or operating at a scale where Vercel's built-in edge
protection isn't enough -- neither is true here yet. Adding one now would
be ongoing cost and complexity with no current problem to solve. Worth
revisiting if traffic ever grows enough to justify it, or if a real attack
happens and Vercel's automatic protection isn't sufficient on its own --
either of those would be a clear, concrete trigger, not a guess.

## If something looks like an attack -- what to actually do

1. **Check for a traffic spike.** The Vercel project dashboard's Analytics
   tab shows request volume over time. A real spike shows as a sharp,
   sustained jump, not normal day-to-day variation.
2. **Check where it's landing.** The `job_submission_log` table
   (new in this session) shows every accepted job submission with its IP
   and timestamp -- a flood shows up as many rows from one or a handful of
   IPs in a short window. `ai_usage_log` is the equivalent for the AI
   review endpoint.
3. **Tighten the limits temporarily, if needed.** The numbers above (10/hour,
   200/day) live in one row of the `billing_guardrails` table and can be
   lowered with a single `update` statement in the Supabase SQL editor,
   with no code deploy and no downtime, then raised back once the traffic
   pattern returns to normal.
4. **For anything beyond what the above can handle** (a sustained flood
   Vercel's own protection isn't absorbing), Vercel and Supabase both have
   support channels for exactly this -- their infrastructure, their call
   on further mitigation. This is the point where a dedicated WAF product
   would actually earn its cost, if it ever comes to that.

No maintenance-mode switch or traffic-redirect step exists in this app
today, and isn't proposed here -- with the layers above in place, the
realistic failure mode this stage of the business needs to plan for is
"tighten a number in a database table," not "take the site down."
