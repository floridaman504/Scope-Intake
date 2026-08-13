# Scope Operational Playbook — Master Prompt Library

Consolidated from 45+ stashed prompts. Organized by category, then priority tier.
Nothing was deleted — overlapping prompts are grouped together under one heading so
you can run them as a set instead of one-by-one. Full original text preserved.

**How to use in Cowork:** Work top to bottom within Tier 1 first. Each numbered block
is a self-contained prompt you can hand to Cowork/Claude as-is. Replace
`[bracketed placeholders]` before running — for Scope, `[your industry]` = trade
industry / plumbing, `[your state]` = Florida, `[your DNS provider]` /
`[Cloudflare / AWS WAF]` etc. = your actual stack (Vercel/Supabase).

Not needed for day-to-day feature work — pull this in when starting on
security-hardening, legal, pricing, retention, or scale-stage tasks specifically.

---

## TIER 1 — Do Now (current build stage: intake form + Supabase live, dashboard in progress)

### 1. Secrets Audit
Perform a secrets audit on my codebase with three steps: (1) Scan every file in the
repository for hardcoded strings that match API key patterns, tokens, passwords,
database connection strings, and secret keys. List every match with file path and
line number. (2) For each exposed secret, generate the replacement using environment
variables, verify the .env file is listed in .gitignore, and confirm the secret is
not present in any previous git commit using git log search. (3) Configure a
pre-commit hook using a secrets detection tool that blocks any commit containing
patterns matching API keys, tokens, or credentials. Test it by attempting to commit a
dummy secret and confirming the push is rejected.

### 2. Cross-Tenant Isolation Audit
Perform a cross-tenant isolation audit on my multi-tenant application with three
steps: (1) Cache layer audit — identify every cached query, page fragment, and API
response. For each cache key, verify tenant ID is included. Flag every cache key that
could return data across tenant boundaries. (2) Shared service audit — review all
shared layers including search indexes, background job queues, file storage paths,
logging pipelines, and WebSocket channels. Verify tenant context is enforced at the
service level, not just the application level. (3) Cross-tenant access test — build
an automated test that logs in as Tenant A, loads each major page, logs out, logs in
as Tenant B, loads the same pages, and flags any data that belongs to Tenant A
appearing in Tenant B's session. Output a vulnerability report with severity ratings
and fixes.

### 3. Session & Auth Management (combined)
Audit my authentication system for session management gaps. Then build: (1) Session
expiration with configurable lifetimes per role — Admin sessions expire after 2
hours, standard users after 24 hours, sliding window refresh on activity. (2)
Concurrent session limits capped at 3 active sessions per user, with a session
registry showing device type, IP, and last activity. (3) A session revocation
endpoint that kills all active sessions instantly on password change, suspicious
activity flag, or manual admin action. Show the middleware implementation.

**Refinement layer — activity-aware timeout + state restore:** Implement session
timeout that tracks meaningful user activity (form submissions, button clicks, API
calls, page navigation) — not mouse movement or passive tab presence. Show a warning
modal 60 seconds before expiration with a one-click extend option. When a session
expires and the user re-authenticates, restore their exact application state: current
page, unsaved form data, workflow position.

**Refinement layer — token handling:** Direct AI to silently refresh, gracefully
fail, and rotate tokens. Login is easy. Keeping users logged in safely is the
orchestration nobody teaches.

### 4. Backup Strategy
Three backup decisions to make right now: How often. Where it lives. Whether you have
ever tested a restore. A backup on the same server as your database is not a backup —
it is a second copy of the same risk. Decide before your users decide for you.

### 5. Test Suite / CI Orchestration
For every feature you build, also write a comprehensive test suite. For the login
flow: test successful login, failed login with wrong password, account lockout after
5 failed attempts, password reset flow, and session creation. Run the test suite on
every commit and fail the build if coverage drops below 60%. Separate unit tests (run
on every push) from integration tests (run on pull requests and merges).

### 6. Frontend Health Audit
Review my app's frontend and check: Organization (components cleanly separated,
consistent naming), Mobile (every screen correct at 375px), Accessibility (right HTML
elements, tab-through works), Consistency (colors/fonts/spacing uniform), Speed
(images optimized, no unnecessary code loaded), Forms (clear error messages, input
preserved on failed submit). Give pass/fail with a specific example for each, overall
score out of 6, top 3 fixes.

### 7. Database Migration Safety (needed soon — dispatcher dashboard will require schema changes)
Before making any production database schema changes, build three things: (1) A
migration script following the expand-contract pattern — add the new column/table
first, copy data over, update the application to use the new structure, then remove
the old structure only after everything is confirmed working. Never drop and
recreate. (2) A rollback script that reverses the migration completely — if the
rollback can't be described step by step, the migration isn't ready to run. (3) A
staging environment test plan — clone the current production schema, run the
migration against the clone with representative data, verify all queries and
application functions still work, then document results before touching production.

### 8. AI-Generated Complexity Debt
Analyze my codebase for AI-generated complexity debt: (1) Abstraction depth — flag
multi-layered abstractions or over-engineered patterns a simpler implementation would
replace. (2) Model-tier audit — list every AI integration/API call/automation and
flag any running on a frontier model that could run cheaper without quality loss. (3)
Tech debt inventory — duplicated logic, inconsistent error handling, undocumented
dependencies, tightly coupled components. Score severity, estimate cleanup hours.

---

## TIER 2 — Before Real Outside Customers (beyond your employer demo)

### 9. Core Security Hardening (combined: error handling, headers, input validation, env separation, audit trail)
Perform a security audit as a third-party auditor: (1) Error handling — identify
every endpoint returning stack traces, framework versions, or DB error details to the
client; replace with generic user-facing errors + backend-only detailed logging. (2)
Security headers — check every response for CSP, X-Frame-Options,
X-Content-Type-Options, Strict-Transport-Security, Referrer-Policy; generate correct
config for my framework. (3) Input validation — audit every form field, API
parameter, and query string for SQLi/XSS/malformed payloads; implement validation
middleware (Zod/Joi) on every input.

Also: (4) Environment separation — verify dev/prod use completely separate
databases, API keys, env vars, config files; flag shared credentials. (5) Sensitive
action audit trail — for every action that modifies permissions, billing, email,
password, or deletes data, log who/when/from what IP/what changed. Output a
compliance-ready audit log schema.

**CSP tightening / attack surface:** Add CSP headers, audit every external resource,
and report before enforcing. Fourteen domains is an attack surface — lock it down.

### 10. Error Handling Rebuild (two-layer, full boundary coverage)
Audit and rebuild error handling with three components: (1) Split into two layers —
a public error handler returning clean, user-friendly messages with no technical
detail, and a private error logger capturing full stack trace, request context, and
user session server-side only. Ensure no stack trace, database connection string,
framework version, or internal path is ever exposed to the client. (2) Boundary
coverage audit — identify every error boundary (API routes, background jobs, webhook
receivers, payment callbacks, cron jobs, third-party integrations); add
try-catch/error middleware anywhere it's missing; configure automated testing
(Vitest for unit tests, Playwright for end-to-end) targeting each boundary with
intentional failure scenarios. (3) Error logging pipeline — centralized log
capturing timestamp, user session ID, route, HTTP method, request input, stack
trace, severity level; searchable/filterable by date, route, severity; retain 90
days minimum.

### 11. DDoS / WAF / Rate Limiting
Secure the application against DDoS and malicious traffic: (1) WAF configuration
(Cloudflare/AWS WAF) filtering SQLi, XSS, volumetric floods — provide config rules
and deployment steps. (2) Adaptive rate limiting — behavioral anomaly detection that
escalates from throttle to temporary ban based on IP/volume/pattern shifts; show
middleware. (3) DDoS response playbook — who gets notified, what goes into
maintenance mode, where traffic redirects, how to activate provider-level
mitigation. Format as an executable runbook.

**Business framing:** Rate limiting is not about saying no — it's about building a
pricing model that scales. Hard limits protect the system. Adaptive limits protect
the experience. Tiered limits protect the business.

### 12. API Security & Versioning
Perform a complete API security and design audit. For each endpoint: list returned
fields, flag over-exposed data, identify sequential ID usage, check for missing
auth. Implement API versioning with /v1/ prefix. Create an API changelog and public
documentation page.

### 13. WCAG AA Accessibility Audit
Full audit: (1) Keyboard — tab through every page with no mouse; every interactive
element reachable/operable; flag focus traps, unreachable elements, missing focus
indicators; fix each. (2) Screen reader — verify alt text, accessible labels on
buttons/links, associated labels on form inputs, proper ARIA landmark roles; fix
every unlabeled element. (3) Color contrast — check every text/background pair
against WCAG AA (4.5:1 normal, 3:1 large text); recommend brand-compliant
replacement colors. Output a full report with pass/fail per page.

### 14. Legal & Compliance Document Bundle
Draft six documents: (1) Terms of service — user rights, liability limitations,
acceptable use, dispute resolution. (2) Privacy policy — accurately describes data
collected, how used/stored, deletion process. (3) Data processing agreement template
for B2B customers. (4) Refund policy — subscription cancellations, prorated
refunds, dispute process. (5) Master service agreement — SLAs, uptime guarantees,
support response times, liability. (6) Cyber liability insurance requirements
checklist — what underwriters expect.

### 15. Entity Structure & Operating Agreement
Research LLC vs S-Corp vs sole proprietorship for a single-founder software company
in Florida. Include tax implications, liability protection, state filing
requirements, investor compatibility. Present a comparison table and recommend the
best fit for a pre-revenue product. Then draft a single-member LLC operating
agreement (Florida) covering profit distribution, management authority, dissolution
terms, and IP assignment.

### 16. GDPR / Data Lifecycle
Map every database table referencing a user record and document what happens to each
relationship on deletion. Implement soft delete: deactivate immediately, retain data
30 days, then auto hard-delete. Build a GDPR data export endpoint generating a
complete report of all data held on a user, confirming complete removal within a
72-hour compliance window.

### 17. Data Retention Architecture
Research federal and state data retention requirements for a trade industry SaaS
application. Identify which record types require mandatory retention and for how
long. Design: (1) A policy engine separating user-deletable data from legally
required retention data. (2) A retention schedule database tracking record type,
applicable regulation, retention period, expiration date. (3) An audit logging
system recording every retention action, anonymization event, and deletion with
timestamps and regulatory justification.

---

## TIER 3 — Scale Stage (once you have paying customers beyond your employer)

### 18. Full 13-Layer Production Readiness Audit (master rollup)
Evaluate all 13 layers — frontend, APIs, database, auth, hosting, cloud, CI/CD,
security, rate limiting, caching, load balancing, error tracking, availability.
Assign GREEN/YELLOW/RED per layer. For every YELLOW/RED: describe the gap, estimate
fix hours. Prioritize RED items by business risk: what can lose money, lose data, or
get you sued. Output as a prioritized remediation plan.

### 19. Serverless Cost & Scaling Decisions
Run a cost comparison: monthly serverless costs at current usage and at 10x.
Equivalent container hosting costs. Estimated weekly ops hours for container
management. Present a decision matrix showing at what usage level containers become
more cost-effective, factoring in ops time at your hourly rate.

Related: Audit for workloads exceeding serverless limits — list every function over
30 sec execution, any WebSocket handler, any queue worker. For the longest-running
workload, create a Dockerfile and container config. Set up serverless functions to
dispatch work to the container via message queue, both reporting to the same
monitoring stack.

### 20. Observability & Monitoring (combined)
External health checks. Correlated traces. SLOs that define "good" before something
breaks. Monitoring is not a dashboard — it's a system that calls you.

**Silent failure layer:** Your error tracker catches errors your code throws. It
cannot catch the ones your code swallows. Add business metric alerting, synthetic
transactions, dead letter queues. Monitor what your tools were never built to see.

### 21. Incident Management (combined: comms + post-mortem + status page)
(1) Public status page on a separate subdomain/host from the main app, with
component-level indicators (API, web app, database, payments, email). (2) Scheduled
maintenance announcements — email 24 hrs before planned downtime, status page post,
in-app banner. (3) Incident response workflow — severity levels, communication
intervals (30 min critical / 2 hr degraded), email templates, post-incident report
structure.

**Post-mortem system:** Template with 5 fields — what happened, impact assessment,
root cause analysis, remediation steps, prevention measures. Auto-schedule
post-mortem review within 48 hours of any incident. Build a searchable knowledge
base by root cause category and failure pattern.

**Trust page:** Security page covering data encryption practices, vulnerability
scanning schedule, pen test history, incident response summary, data storage
locations, vulnerability reporting contact.

### 22. Session Replay & Rage-Click Detection
Add session replay — watch what happened from the user's screen. Connect replays to
error tracking. Flag rage clicks. Stop asking, start watching.

### 23. Retention & Re-engagement Analytics (combined)
(1) Cohort dashboard — group users by signup week, track % returning weeks 1/2/3/4/8,
visualize retention curve. (2) Usage event tracking on core features — adoption
rate, frequency, time between uses; flag features under 20% adoption. (3) Drop-off
alert — flag users whose activity drops 50%+ below personal baseline for 7 days,
trigger re-engagement email referencing their last-used feature.

**Refinement:** Establish personal baseline from first two weeks. Flag drop below
50% of baseline. Trigger re-engagement showing new features since last session +
cohort progress. No "we miss you" language.

### 24. Email Deliverability
Audit and configure: (1) SPF/DKIM records for sending domain, step-by-step DNS
instructions. (2) Dedicated subdomain for transactional email (receipts, resets,
notifications) separate from marketing — rationale for reputation isolation. (3)
Delivery monitoring dashboard — inbox placement rate, bounce rate, spam complaint
rate; recommend a tool and show integration.

### 25. Payment Protection (combined: dunning + disputes)
**Dunning:** Retry schedule at day 1/3/5/10 after failed charge. Three-email
sequence (failure day, day 3 urgency, day 7 final notice). 14-day grace period with
active account + in-app banner. Show Stripe webhook handlers and email triggers.

**Dispute protection:** Published refund policy page linked from checkout.
Chargeback threshold monitoring — alert at 0.5% and 0.75% dispute rate. Dispute
response workflow — transaction logs, delivery confirmation, refund policy evidence,
response timeline checklist.

### 26. SaaS Sales Tax Nexus
Research SaaS sales tax nexus requirements. Build: (1) Nexus exposure analysis from
Stripe customer list — revenue/transactions by state vs. economic nexus thresholds;
flag states at/near threshold. (2) Guide for enabling Stripe Tax, applicable SaaS tax
codes. (3) Compliance filing calendar — nexus states, filing frequency, deadlines,
penalties.

### 27. Internationalization
(1) Multi-currency via Stripe — automatic conversion at checkout, local currency
display; list enabled/needed currencies. (2) Locale-aware formatting — replace
hardcoded US date/number/currency/time formats with browser/profile-based detection.
(3) Timezone-aware scheduling — store user timezone at signup, convert all scheduled
comms to fire in user's local time. Output a checklist with file paths.

### 28. AI Shopping/Agent Discoverability
(1) Structured data audit — JSON-LD/Open Graph/product schema on every
product/pricing/feature page; generate missing schema. (2) Machine-readable spec
page/JSON endpoint covering pricing, features, integrations, uptime, security certs,
data export, currencies, compliance. (3) Query ChatGPT/Claude/Gemini with 5
purchase-intent prompts in your category; document whether you appear, accuracy,
gaps. Output a gap report with fixes.

### 29. Support & Ticketing (also = reference for your personal AI management agent)
Build a support ticket classification system: automated resolution (known issues),
assisted triage (unknown issues escalated with context), human-required (billing
disputes, disguised feature requests, escalated emotional situations). Auto-route
tickets. Human-required tickets include full customer interaction history. Use as a
design reference for your personal AI agent's task-routing logic too.

---

## BUSINESS / PRICING / SALES (Scopewell Pricing Plan)

### 30. Pricing Philosophy
Anchor on value, not hours — model hours saved × labor cost, revenue unlocked,
errors eliminated, in the client's own numbers. Modular pricing sells certainty —
fixed blocks of defined scope (reference: $8,000 / 40-hr block). Written scope is
your fixed-price armor — explicit inclusions AND exclusions; brainstorm the "out of
scope" list proactively. Three options beat one number — present most complete
option first to anchor value; tiers self-select budget. Deposits and milestones
protect cash — deposit before first-time client work, payments against milestone
deliverables. Discounts get traded, never given — calculate your walk-away number
(tools, taxes, unbillable time, margin) before any negotiation, decided calmly in
advance.

### 31. Toolkit / Stack
Claude/ChatGPT — pricing analyst and proposal writer (value modeling, tiered
options, scope drafts, negotiation prep, walk-away math). Stripe — payment links,
deposits, milestone invoicing. QuickBooks/Wave — invoicing and cost visibility
behind your rates. Notion — rate card, module menu, proposal templates as a standing
reference.

### 32. Pricing Audit
Review pricing setup: Value anchor (price tied to quantified outcome or to
hours/costs?), Structure (fixed blocks with written inclusions/exclusions?), Options
(tiered with most-complete first, or single number?), Payment terms (deposit +
milestones, or all risk until completion?), Floor (minimum viable price per module
vs. business costs — flag anything priced below it), Discount discipline (traded or
conceded?). Score out of 6, top 3 fixes.

### 33. Delivery Process Audit
Review client delivery: Scope (SOW covers deliverables, price, timeline, exclusions,
testable acceptance criteria?), Kickoff (single decision-maker, comms plan, access
checklist, written recap within a day?), Milestones (defined milestones with working
demos, or one final reveal?), Communication (status updates cover
shipped/next/blocked?), Change control (scope changes confirmed in writing with
price/timeline impact before building?), Handoff (documentation, live walkthrough,
final payment confirmation, defined support window?). Score out of 6, top 3 fixes.

### 34. Portfolio Audit
Review portfolio: Aim (would a niche prospect see their own problem within 90
seconds?), Structure (problem/approach/result with a measurable number?), Proof
format (outcome-first video/live link vs. screenshots only?), Method (states you
direct AI through a professional process, shows how quality is enforced?), Freshness
(most recent piece representative, every demo runs?), Permissions (client pieces
shown with agreed permission, testimonials attributed?). Score out of 6, top 3
fixes.

### 35. Scaling Readiness Audit
Review readiness to scale past solo: Signal (demand actually exceeding capacity vs.
adding overhead?), Agreement (subcontractor agreement covers
scope/pay/deadlines/confidentiality/ownership/non-solicitation?), Process (could a
competent builder deliver to your standard from what's written down?), Quality gate
(defined review everything passes before clients see it, and you own it?), Economics
(rate vs. subcontractor pay spread covers QA/management/revision risk/margin?),
People (pilot structure, prompt payment terms, clean exit path?). Score out of 6,
top 3 fixes.

### 36. Proposal Template Package
(1) Out-of-scope section with 10 common exclusion categories (hosting management,
third-party API costs, content creation, ongoing maintenance, training, data
migration, etc.) — customizable language. (2) Change order process — how scope
additions are requested, estimated, priced, approved, with a change order form
template. (3) Acceptance criteria framework with examples per deliverable type
(dashboard, API, auth system, reporting module) — what "done" looks like, measurably.

### 37. Social Proof Page
Design a standalone page organizing testimonials, social comments, reviews, and
third-party feedback by product/service category. Each item: name/handle, platform,
date, quote. Group by product. Output as responsive HTML matching existing site
design.

### 38. Client Qualification System — Scope upper-tier feature candidate
(1) Red flag scorecard — score prospective clients on scope clarity, budget
alignment, communication patterns, decision speed, expectation realism (1–5 each);
flag any client under 15 total as high risk. (2) Professional decline templates for
scope mismatch, budget misalignment, timeline conflict, red flag behavior — preserve
the relationship while closing the door. (3) Post-decline review log — why you said
no, what the warning signs were, what to screen for earlier next time.

---

## Priority Recap

- **Tier 1 (now):** Secrets, tenant isolation, session/auth, backups, test suite,
  frontend audit, complexity debt
- **Tier 2 (before outside customers):** Security hardening, DDoS/rate limiting, API
  security, accessibility, legal docs, entity structure, GDPR/data lifecycle,
  retention architecture
- **Tier 3 (scale stage):** Full production audit, cost/scaling, observability,
  incident management, session replay, retention analytics, email deliverability,
  payment protection, tax nexus, i18n, AI discoverability, support ticketing
- **Business track (run in parallel, anytime):** Pricing philosophy + audit, delivery
  audit, portfolio audit, scaling readiness, proposal templates, social proof,
  client qualification (future Scope feature)
