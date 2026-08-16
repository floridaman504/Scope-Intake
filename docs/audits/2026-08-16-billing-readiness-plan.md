# Billing readiness -- a plan, not a build

## Why this document exists

While closing out the audit-trail gaps (role editing, then email change),
it came up that "billing changed" was a third checklist category with
nothing behind it to log -- because there's no billing at all in this app
today. Dante's direction on this one was explicit and different from the
other two: don't build it now. He's planning to sell higher, paid tiers of
Scope in the future, and wants a plan for how billing would work when that
time comes -- not a payment system bolted on ahead of a business decision
that hasn't been made yet.

So this is scoping only. No Stripe integration, no payment code, no new
database tables, nothing that touches money in this document or the PR it
ships in. That's a deliberate choice, not an oversight: billing is the kind
of thing that's expensive to redo if built before the pricing and tiers are
actually decided, and there's a real cost to carrying unused payment
infrastructure (and the security obligations that come with it) before it's
needed.

## What exists today

Nothing. To be specific about what "nothing" means:

- `companies.plan` is a text column that's been sitting in the database
  since the very first schema, defaulted to `'standard'` on every company.
  No code anywhere in the app reads it, writes it, or checks it. It doesn't
  gate any feature.
- There's no payment processor connected (no Stripe account referenced
  anywhere in the code or environment config).
- There's no concept of a subscription, an invoice, a card on file, or a
  billing contact.
- There's no UI anywhere -- owner dashboard included -- that shows a plan,
  a price, or a "manage billing" link.

This isn't a gap that needs fixing today. It's just the honest starting
point for what "add billing" actually means when the time comes: everything
below would be new, not a small addition to something partial.

## What "billing for higher tiers" will actually require

Four separate pieces, roughly in the order they'd need to be built:

**1. The business decision, first.** What are the tiers, what does each one
unlock, what's the price, monthly vs. annual, and is there a free tier or
trial. This has to come from Dante -- it's not something to guess at or
half-build speculatively. Everything below depends on this being decided
first.

**2. A payment processor.** Stripe is the standard choice for a SaaS this
size, and is what this plan assumes -- it handles the parts that are
genuinely dangerous to build in-house (storing card numbers, PCI
compliance, retry logic on failed payments, tax calculation via Stripe Tax)
so this app never needs to touch raw card data at all. Two of its pieces
fit this app well specifically:
  - **Stripe Checkout** -- a hosted payment page Stripe provides. The app
    redirects an owner there to subscribe or change plans; Stripe handles
    the actual card entry. Keeps this codebase from ever seeing card
    numbers, which also keeps it out of most of PCI compliance scope.
  - **Stripe Customer Portal** -- a hosted page Stripe provides for
    managing an existing subscription (update card, view invoices, cancel).
    Means this app doesn't need to build any of that UI by hand.

**3. A sync point between Stripe and this database.** Stripe sends webhook
events (subscription created, payment failed, plan changed, subscription
canceled) to a URL this app would provide -- a new serverless function,
same pattern as the app's existing Vercel functions. That function's whole
job is to update `companies.plan` (and a small number of new columns --
see below) to match what Stripe says is true. This is the one new piece of
custom code in the whole system, and it's intentionally narrow: it never
decides prices or handles money directly, it just keeps this app's copy of
"what plan is this company on" in sync with Stripe's copy.

**4. Feature gating.** Once `companies.plan` actually means something,
whatever features are tier-gated (the plan doc doesn't guess what those
are -- that's part of the business decision in step 1) get checked the same
way this app already checks role today: `get_my_company_id()`-style
lookups feeding into RLS policies, or a plain `if` in the UI for
softer gates like usage limits. No new pattern needed -- this app already
has the infrastructure (`get_my_company_id()`, `get_my_role()`) that a
`get_my_plan()` companion function would slot into cleanly.

## Roughly what would change in the database, when it's time

Kept intentionally light -- this is not a migration to run now, just a
sketch so the size of the eventual work is clear:

- `companies` gains a few more columns: a Stripe customer id, a Stripe
  subscription id, and a subscription status (active, past_due, canceled,
  etc.) -- `plan` stays as the human-readable tier name, these new columns
  are what the webhook sync function actually writes.
- A new webhook-handling serverless function, with its own secret (Stripe
  signs every webhook payload so the endpoint can verify it's really from
  Stripe and not spoofed) -- this would be the one new secret this feature
  needs, kept in the same environment-variable pattern the app already
  uses for its existing keys.
- Optionally, a `billing_events` audit-style table (or an extension of the
  `audit_log` table from the audit-trail work) so plan changes and payment
  failures show up in the same kind of trail as everything else in this
  app -- closing the original gap this whole plan started from.

## What this means for the audit-trail checklist

The "billing changed" category stays open -- honestly, not silently -- until
there's an actual billing feature to log against. This document is the
placeholder that explains why, so it doesn't read as a dropped task later.

## Recommendation

Don't start building any of this until the tiers and pricing in step 1 are
decided. Once they are, the right first move is standing up Stripe Checkout
and the webhook sync function (steps 2 and 3) before touching any
feature-gating -- that gets the plumbing tested and trustworthy with real
(or sandbox) payments before anything in the app actually depends on it
being correct.
