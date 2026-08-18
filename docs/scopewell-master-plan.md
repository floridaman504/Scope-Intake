# Scopewell — Master Plan

Status: this is now the live plan. It supersedes the original context brief and the
pricing session's handoff — it merges both, fact-checks the pricing session's
competitive claims against real current market data, and revises two things the
pricing session underweighted. Written by the Cowork session leading Scopewell's
build, at Dante's direction, to be the one document both of us work from going
forward.

## Stage reality (unchanged, still true)

Scopewell is live, hand-sold, hand-onboarded. No billing exists anywhere in the app.
No self-serve signup exists — one company ("Demo Company") in the database, created
by hand. Nothing is feature-gated. Every decision below is built on that reality, not
around a self-serve SaaS business this isn't yet.

## Decided: the business model

Hybrid — a one-time setup fee (deposit + milestone) plus a flat monthly fee. Not
subscription-only, not a pure one-off project. Structurally the same shape as
ServiceTitan/FieldEdge (implementation fee + subscription); the difference is size and
honesty — small, disclosed, no lock-in, cancel anytime. Confirmed against real
ServiceTitan numbers below — this positioning holds up.

No tiered or feature-gated pricing yet. Nothing in the app is feature-gated today,
so a tiers page would be selling something that doesn't exist. Tiers become real once
there's an actual reason to gate something (seats, AI-review volume) and the metering
to enforce it — that's a Stage 3 item, not now.

## Founding customer pricing — revised

**Your employer (6-8 plumbers, dispatch, 2 owners — currently on Jobber):**
Setup $0-500. Monthly $99-149/mo. Keep this track exactly as proposed — the low setup
fee is the right call here specifically because you already know their operation, and
because they're the flagship reference customer. This is still a real invoice/scope/
deposit deal, not a favor.

Fact-checked: Jobber's real tiers are Core $49/mo, Connect $149/mo (capped at 5
users), Grow $249/mo (capped at 10 users). At 9-11 people, your employer is at or past
the Grow cap — meaning they're very likely already paying $249/mo or hitting per-seat
overage. Scopewell's $99-149/mo isn't just cheaper, it's meaningfully cheaper. This
pitch is stronger than the original draft even claimed.

One honesty check before you pitch it: Jobber's Grow tier includes marketing tools,
automated lead follow-up, referral campaigns, and advanced reporting — Scopewell
doesn't have any of that today. Pitch it as "cheaper, and does this one thing
better" (AI-structured intake, role-based dispatch) — not as feature parity plus
cheaper. If they ask "what happened to X" and you don't have an honest answer ready,
that undercuts the whole pitch.

**Standard founding prospects (revised):** Setup $0-500 for the first 2-3 non-employer
customers, not $750-1,500. Reasoning: Jobber charges zero setup fee on every tier it
sells. Asking a shop currently paying Jobber $0 to switch to something that costs
money just to get started, before they've seen a day of value, is real friction the
original draft didn't fully account for. Once you have 2-3 testimonials and a proven
onboarding process, raise standard setup back to $750-1,500 — the fee becomes
justifiable once there's proof behind it, not before. Monthly stays $99-149/mo from
day one; that part of the original plan was right, keep it.

**After 3-5 founding customers with proof:** Setup $2,500-4,000, monthly $149-249.
Your original ~$8,000/40-hr reference point is real and correct — for later, bigger,
proven-value deals, not the first unproven sale.

## Competitive positioning — revised framing

**Now (Stage 1):** Small shops currently on Jobber, starting with your employer.
Jobber's switching friction is genuinely low (month-to-month, no termination fee) —
this is a real displacement sale against a soft incumbent. Say "cheaper than what
you're paying Jobber, and does AI-structured intake and role-based dispatch Jobber
doesn't have" — not "does everything Jobber does, cheaper."

**Later (Stage 2/3):** Larger shops, including out-of-state, fed up with
ServiceTitan. Fact-checked and confirmed real: ServiceTitan runs $245-500 per
technician monthly, $5,000-50,000 implementation fees, $25,000-70,000+ in real Year 1
cost for a 5-10 tech shop, and documented complaints about termination fees as high as
$39,375. "ServiceTitan-grade capability without the ServiceTitan-grade contract" is a
provable claim, not a marketing line. Don't pitch this segment yet — it needs features
(multi-location support, deeper reporting) that don't exist yet, and showing up
underbuilt to a burned-by-ServiceTitan prospect wastes a hard-won lead.

## Walk-away number / time-value framework — kept, with one caveat

Your W2 wage (~$28/hr) is near-zero real opportunity cost for Scopewell work during
downtime at that job. Your real opportunity cost for dedicated evening/weekend hours
is your side-hustle plumbing rate — $150-300/hr, evidenced by real $1,000-2,000 cash
jobs completed in 1-2 days. Onboarding time per new customer is estimated at 10-15
hours (unvalidated placeholder — replace with real timed data after customer #1).

Caveat worth keeping in mind: that $150-300/hr number is a ceiling, not necessarily an
average — it assumes every evening spent on Scopewell is an evening you'd otherwise
have a paying plumbing job lined up. If side-hustle jobs aren't available literally
every week on demand, your real average opportunity cost is somewhat lower, which
would make the founding-customer discount look smaller than the ceiling math suggests.
Doesn't change the pricing above — just don't let the $150-300/hr number harden into
gospel before you've tracked it for real.

At the ceiling number, founding pricing still doesn't fully cover your time
($150 x 10-15 hrs = $1,500-2,250, against $0-500 setup for your employer or the
revised $0-500 for early standard prospects). That gap is a deliberate, conscious
discount for reference-customer value — re-decide it each time, don't let it become
a silent default once you're past the founding cohort.

## Blockers — reordered by actual risk, not just checklist order

**1. Employment-agreement check — do this FIRST, before anything else on this list.**
This was flagged as "worth 10 minutes, not expected to be an issue" before. I'm
elevating it: this check gates your single highest-value pitch — your own employer —
and if there's a moonlighting or IP-assignment clause, the downside isn't "the deal
falls through," it's a real dispute over who owns Scopewell itself, built with
knowledge of their operation while you were employed there. Read the agreement (or
have someone who isn't me who's actually qualified glance at the relevant clause)
before drafting one more word of the employer pitch. Not done yet as of this plan.

**2. A simple LLC — form before invoicing real customer money, and finish the whole
job, not just the filing.** File direct through Florida's Secretary of State site
(skip LegalZoom's markup, typically under $300 to file). But filing articles alone
doesn't protect you — you also need an EIN and a separate business bank account, and
you need to actually keep Scopewell money separate from personal and plumbing income
from day one. An LLC that shares a bank account with your personal finances can be
pierced in a dispute; the paperwork alone isn't the protection, the separation is.
I can walk you through each step and explain what each piece is for — I can't file
this, get you an EIN, or open a bank account on your behalf; those need to be you,
directly, since they involve your identity and financial credentials.

**3. Stripe Payment Links — set this up once #1 and #2 are moving, before the first
sale closes.** No-code, roughly 15 minutes, supports both one-time (deposit/setup)
and recurring (monthly) links. This needs your own Stripe account with your own
banking details — I can give you the exact click-by-click steps, but I can't create
the account or enter financial info on your behalf. Nothing in the app needs to
change for this to work; it's fully outside the codebase at this stage.

## Roadmap stages — entry/exit criteria added

**Stage 1 (now):** Hand-sold founding customers, hybrid setup+monthly pricing
(revised above), Stripe Payment Links as the only billing infrastructure. Exit
criteria: 3-5 paying customers with real usage and at least one testimonial/case
study.

**Stage 2 (after Stage 1 exit criteria are met):** Raise pricing to the proven-value
tier ($2,500-4,000 setup, $149-249/mo). Build the internal fast-onboarding admin
tool — already the next planned engineering task, and now has real urgency since
manual database onboarding won't hold past a handful of customers. Consider usage
metering as groundwork for Stage 3, not yet for gating anything.

**Stage 3 (proven, scaled):** Self-serve signup, real billing/subscription
infrastructure (Stripe webhooks syncing to `companies.plan`, per the original billing-
readiness plan already on file), tiered feature-gated pricing (the $99/$299/$599
placeholder becomes real), and the ServiceTitan-refugee segment becomes reachable
once multi-location/reporting features exist to back the pitch.

## Immediate action checklist — who does what, in order

1. **[Dante]** Read your employment agreement (or get 10 minutes with someone
   qualified) for moonlighting/IP-assignment language. Report back go/no-go before
   the employer pitch moves further.
2. **[Dante]** File the Florida LLC directly through the Secretary of State site, get
   an EIN, open a separate business bank account. I can walk through each step live
   if useful.
3. **[Dante]** Set up a Stripe account and create your first Payment Link (one for
   setup/deposit, one recurring for monthly) — I'll give you the exact steps when
   you're ready for this one.
4. **[Claude]** Nothing engineering-side is blocked on 1-3 — Stage 1 needs zero app
   changes. I'll hold here on new Scopewell code until you give the word, since the
   real next blocker is business/legal, not technical.
5. **[Both]** Once 1-3 are done and the employer pitch is drafted (you mentioned this
   is already in progress separately), close founding customer #1.
6. **[Claude]** Once you're at or near the Stage 1 exit criteria (3-5 customers,
   testimonial in hand), I start planning the fast-onboarding admin tool — that's
   the next real engineering project, and I'll bring you a plan for it before writing
   code, same as always.

## Still open — needs Dante's input, not assumptions

Real onboarding-hours data from customer #1, to replace the 10-15 hour placeholder.
Confirmation the employment-agreement check is done. Timing and final go/no-go on the
employer pitch itself.
