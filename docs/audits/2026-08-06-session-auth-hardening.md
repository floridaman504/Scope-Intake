# Session/Auth Hardening — 2026-08-06

## Question this answers
Tier 1 item 3: does Scope's session management hold up to the playbook's
five requirements (per-role expiration, concurrent-session limits, a
revocation endpoint, activity-aware timeout with warning + state restore,
and sound token handling)? What's genuinely buildable on this project's
**Free** Supabase plan, and what would need a plan upgrade?

## The one fact that shapes everything else here

Checked directly against the live dashboard (Auth > Sessions,
`etpzprrroxjjroisboui`, 2026-08-06): the panel that would give this for
free —Time-box user sessions, Inactivity timeout, Single session per
user — is disabled with the message **"Configuring user sessions is only
available on the Pro Plan and above."** Confirmed against Supabase's own
docs too (`supabase.com/docs/guides/auth/sessions`): *"Limiting session
lifetime and number of allowed sessions per user... is only available on
Pro Plans and up."* Pro is $25/mo per project.

What Free **does** give you, and what's already true today: the access
token (JWT) expiry field is a normal Free-tier setting, currently **3600
seconds (1 hour)**, the Supabase default. Auto-refresh, session
persistence, and refresh-token rotation (single-use refresh tokens, reuse
detection) are all standard `supabase-js` behavior on every plan, no
config needed.

So: no native per-role TTL, no native concurrent-session cap, no native
inactivity timeout, on this plan, today. Everything below is an app-level
layer built on top of what Free actually gives you, not a workaround that
pretends to be the Pro feature.

## Gap analysis (before any changes)

Read `src/AuthContext.jsx`, `src/ProtectedRoute.jsx`, `src/Login.jsx`,
`src/Join.jsx`, `src/supabaseClient.js` as they stood before this work:

- **No session expiration policy of any kind.** A session lasted until
  the access token's natural 1-hour expiry, refreshed silently forever
  by `supabase-js`'s default auto-refresh, with no distinction between an
  Owner (who can see billing/invite codes/every job) and a Plumber.
- **No concurrent-session limit.** Unlimited devices per account, no
  visibility into how many, whose, or from where.
- **No revocation path at all.** No "sign out everywhere," nothing tied
  to a password change (there's currently no password-change UI in the
  app either — noted below), no admin kill switch. `supabase.auth.signOut()`
  only signs out the calling device's local session; other devices'
  sessions were untouched.
- **No activity tracking, no warning modal, no state restore.**
  `ProtectedRoute` did a single synchronous check (`session` truthy or
  not) and either rendered the page or bounced to `/login` with zero
  memory of where the user had been or what they were doing.
- **Token handling was already mostly fine** — `autoRefreshToken`,
  `persistSession`, and rotation are `supabase-js` defaults and were
  already in effect, just not documented as intentional, and there was no
  handling for what happens in the UI if a refresh ultimately fails
  (`onAuthStateChange` firing `SIGNED_OUT` just silently nulled the
  session and let `ProtectedRoute`'s existing check redirect — functional,
  but no message to the user about why, and no attempt to preserve their
  place).

## What was built

**`supabase_session_hardening.sql`** (new file, root of repo, **not run
against production** — see below):

- `session_policy` table: `role`, `max_lifetime_minutes`,
  `concurrent_session_limit`. Seeded `owner=120min`, `dispatcher=1440min`,
  `plumber=1440min`, cap `3` for all three, matching the playbook's 2hr /
  24hr / 24hr numbers. Dante can change these numbers directly in the SQL
  editor — no redeploy needed, the client reads this table on every login.
- `user_sessions` table: one row per registered session, with `user_id`,
  `company_id`, `role_at_login`, `device_label`, `user_agent`,
  `ip_address` (best-effort, see caveat below), `created_at`,
  `last_activity_at`, `revoked_at`, `revoked_reason`. RLS: a user sees
  their own rows; an Owner sees every row for `company_id =
  get_my_company_id()` (reusing the same helper functions the
  cross-tenant audit already verified). No direct insert/update/delete
  grant to `authenticated` — every write goes through one of:
  - `register_session(device_label, user_agent)` — called once per
    login. Enforces the concurrent cap by revoking the oldest active
    sessions beyond the role's configured limit.
  - `touch_session(session_id)` — called on real activity (throttled
    client-side, see below). Updates `last_activity_at` and returns
    whether the session is still valid, so the client can detect
    server-side revocation or an already-elapsed inactivity window in the
    same round trip.
  - `revoke_session(session_id, reason)` — single-session revoke, used by
    the per-row "Revoke" button in the session registry. Self-callable,
    or Owner-callable against any session in their own company.
  - `sign_out_everywhere(target_user_id default null)` — **the
    revocation endpoint.** Null/self target revokes all of the caller's
    own sessions (wired to a "Sign out everywhere" button on the
    dashboard, and to a `changePasswordAndSignOutEverywhere()` helper in
    `AuthContext` ready for whenever a password-change UI exists — there
    isn't one today, see caveat below). A non-null target only works for
    an Owner acting on an employee in their own company (checked
    server-side), covering "manual admin action."
  - Table added to the `supabase_realtime` publication so a revoked
    session gets pushed to the affected client within seconds instead of
    waiting for the next poll (Free tier includes Realtime, no cost).
- Every `create policy` is preceded by `drop policy if exists`, and the
  realtime publish is wrapped in an existence check, matching the
  idempotent style already used in `supabase_fix_rls_recursion_and_tenant_isolation.sql`
  on `scopwell-preview` — the whole file can be re-run safely if a run
  is interrupted partway.

**Client-side (all real code, not stubs):**

- `src/sessionConfig.js` — fallback role-TTL constants (used only if
  `session_policy` can't be reached), warning lead time (60s), activity
  throttle (20s), backstop poll interval (30s), restore-snapshot
  constants, and a small user-agent → device-label parser.
- `src/activityTracking.js` — a plain module (not a hook, so
  `AuthContext` is the single owner of "when did the user last do
  something") that listens for `click`, `submit`, and real `keydown`
  events (bare modifier presses excluded) and exposes `recordActivity()`
  for call sites to mark a successful API call as activity too — wired
  into `Join.jsx`'s `redeem_invite_code` call as the one example that
  exists in the app today. Deliberately does **not** listen to
  `mousemove` or count a backgrounded/idle tab as activity, per the
  playbook.
- `src/AuthContext.jsx` — rewritten. Registers/reuses a `user_sessions`
  row per tab (persisted in `sessionStorage` so a page refresh doesn't
  spawn a new row and self-evict other devices via the cap), tracks
  activity and throttles `touch_session` calls, runs a 1-second local
  countdown against `last_activity + role_ttl` (sliding window — every
  real activity event resets the clock), shows the warning modal at 60s
  remaining, force-signs-out on expiry or on a `touch_session` /
  realtime / poll response indicating revocation, and — on ANY
  transition from authenticated to signed-out that the app itself didn't
  initiate (refresh failure, revocation from elsewhere) — saves a
  snapshot (`{path, formData}`) to `sessionStorage` before redirecting to
  `/login?expired=1&reason=...` so `Login.jsx` can send the user back and
  show *why* they were signed out. Exposes `signOut`,
  `signOutEverywhere(targetUserId?)`, `changePasswordAndSignOutEverywhere`,
  `extendSession`, `registerFormSnapshot`, `consumeRestoreSnapshot`.
- `src/SessionExpiryWarning.jsx` — the 60-second warning modal, "Stay
  signed in" (one click, calls `extendSession`) or "Sign out" now.
  Rendered once in `main.jsx`, inert whenever there's no session.
- `src/SessionRegistry.jsx` (new route: `/sessions`) — Owner sees every
  session for every employee in their company (name, role, device,
  best-effort IP, last-active, created, revoked status) with per-row
  Revoke and per-user "Sign out everywhere." Non-owners land on the same
  route and see only their own sessions (RLS enforces this even if
  someone hits the URL directly — the route is also role-gated in
  `ProtectedRoute` as defense in depth, not the only control).
- `src/ProtectedRoute.jsx` — now also saves a restore snapshot when it
  redirects an unauthenticated visit to `/login` (covers direct/bookmarked
  links to a protected page, using the same snapshot format
  `AuthContext` uses so `Login.jsx` only has one thing to read).
- `src/Login.jsx` — reads `?expired=1&reason=...` and shows a specific
  message (inactivity vs. revoked vs. refresh failure vs. concurrent-limit
  hit) instead of a generic error; after a successful sign-in, restores
  to the saved snapshot path if one exists and is < 30 minutes old and is
  a same-origin relative path (guards against the snapshot ever being
  used as an open redirect), otherwise falls back to `/dashboard`.
- `src/Dashboard.jsx` — added "Manage team sessions" / "Your active
  sessions" link and a self-service "Sign out everywhere" button.
- `src/supabaseClient.js` — `autoRefreshToken`, `persistSession`,
  `detectSessionInUrl` set explicitly (were already `supabase-js`
  defaults; made explicit so a future cleanup pass doesn't remove them by
  accident) with a comment explaining these satisfy the "silent refresh"
  and "rotation" requirements — rotation itself is server-side Supabase
  Auth behavior, not something the client configures.

**Fails open, not closed, until the SQL is applied.** Every RPC call into
the new schema (`register_session`, `touch_session`, etc.) is wrapped in
try/catch. If the function doesn't exist yet — i.e., this code ships
before Dante runs the migration — the app logs a console warning and
falls back to plain Supabase auth with none of the extra hardening
active, rather than breaking login for everyone. Confirmed with a local
`vite build` that the whole app still builds and the existing pages
render with this code in place.

## Honest limits of this design (read before trusting it)

- **This is not instant revocation.** A revoked session's *access token*
  (JWT) remains cryptographically valid to Supabase's own API/RLS layer
  until its own natural expiry (currently 3600s / 1hr on this project) —
  Supabase doesn't give a way to invalidate an already-issued JWT early
  on Free or Pro. What this build does is stop the **app** from acting on
  a revoked session quickly: realtime push (typically sub-second) with a
  30-second poll as a backstop if the realtime channel drops. If someone
  captured a raw access token directly (outside the app, e.g. via a
  browser extension or logged request), it would keep working against
  the Supabase API directly for up to the remaining JWT lifetime
  regardless of what `user_sessions.revoked_at` says. Recommendation:
  once this is live and stable, consider lowering the access token expiry
  (Auth > Sessions > Access Tokens, Free-tier setting) from 3600s to
  something like 900s (15 min) to shrink that residual window — that's a
  separate, global (not per-role) change with its own tradeoff (more
  refresh traffic), so I left it as a recommendation rather than making
  it part of this migration.
- **IP address capture is best-effort.** `register_session()` reads
  `x-forwarded-for` from `current_setting('request.headers')`, which
  PostgREST populates from the incoming request. This is usually the real
  client IP but can reflect a proxy/CDN hop depending on network path —
  treat the registry's IP column as informational, not an audit-grade
  log.
- **No password-change UI exists in the app today.** `changePasswordAndSignOutEverywhere()`
  is built and ready in `AuthContext`, but there's nothing in `Login.jsx`/
  `Join.jsx`/`Dashboard.jsx` for a user to actually change their password
  from — Supabase Auth has no self-serve password reset UI wired up
  either. That's arguably its own follow-up item, not strictly in Tier
  1.3's scope, but flagging it since "kills all sessions on password
  change" implies a password-change feature that doesn't exist yet.
- **State restore covers page + snapshot mechanism, not a live demo of
  form data, because there's currently no in-app form behind
  `ProtectedRoute` to demo it with.** `Dashboard.jsx` is a one-page stub
  with no forms. `registerFormSnapshot(getterFn)` is built and wired into
  the save/restore path end-to-end — the next form added behind auth
  (e.g. job editing) can opt in with one line — but I'm not fabricating a
  fake form just to exercise it. Page-path restore (which page you were
  on) works today and doesn't depend on this.
- **Concurrent-session cap and per-role TTL are enforced by the app, not
  by Supabase Auth itself.** If Free tier is later upgraded to Pro, the
  right move is to also turn on the native Auth > Sessions controls
  (Time-box, Inactivity timeout, Single session) as a second, Supabase-
  enforced layer — they're not mutually exclusive with what's here, and
  the native layer covers the raw-JWT gap this app-level layer can't.

## Exactly what SQL is pending Dante's go-ahead, and why I didn't run it

The full migration is `supabase_session_hardening.sql` at the repo root —
two new tables (`session_policy`, `user_sessions`), five new
`SECURITY DEFINER` functions, RLS policies on both new tables, and one
`alter publication` statement. I did not run any of it against
`etpzprrroxjjroisboui` because the task boundary for this audit is
explicit: read-only introspection against production is fine, CREATE/
ALTER/INSERT is not — that's Dante's call, same as the RLS grant
tightening recommended in the cross-tenant audit that's also still
pending. The only things I ran against the dashboard this session were
read-only: loading the Auth > Sessions settings page to confirm the
Pro-plan gate and the current 3600s JWT expiry (no query editor, no
writes).

## Manual verification checklist once the SQL is applied

1. Run `supabase_session_hardening.sql` in the SQL editor (fresh query
   tab, screenshot-confirm the text matches this file, click Run — not
   Ctrl+Enter).
2. Log in as an existing employee, confirm a row appears in
   `user_sessions` with the right `role_at_login` and `company_id`.
3. Log in from a 4th browser/device as the same user and confirm the
   oldest of the previous 3 gets `revoked_at` set (concurrent cap).
4. As that revoked session, confirm the app signs itself out within ~30s
   (realtime) or within the next poll, and lands on `/login?expired=1`
   with the "signed out" message.
5. As an Owner, visit `/sessions`, confirm you see every employee's
   sessions in your company and nobody else's; as a non-owner, confirm
   `/sessions` only shows your own rows.
6. Click "Revoke" on another device's session from the registry, confirm
   that device gets signed out.
7. Click "Sign out everywhere" on the dashboard, confirm all other
   sessions revoke and the current tab signs out too.
8. Leave a tab idle (no clicks/keystrokes) past the warning threshold,
   confirm the modal appears at 60s remaining with a working countdown,
   "Stay signed in" resets it, and letting it expire redirects to
   `/login` with a restore snapshot that sends you back to the same page
   after re-auth.
9. Directly hit a protected URL while logged out, confirm you land on
   `/login` and get sent back to that same URL after signing in.
10. Confirm the app still works normally (login, dashboard, sessions
    page) with the migration NOT applied yet, on a throwaway branch/
    preview — this checks the fail-open behavior isn't accidentally
    fail-closed. (I verified this locally via `vite build` succeeding and
    the try/catch guards in `AuthContext.jsx`, but haven't watched it
    run against a live unmigrated project in a browser.)

## Not done / explicitly out of scope for this item

- Did not touch `scopwell-preview`, did not adopt its rebrand or any of
  its unrelated features, per the task boundary.
- Did not lower the production access-token (JWT) expiry setting —
  flagged as a recommendation above, left as Dante's call since it's a
  global, not per-role, setting with a real tradeoff.
- Did not build a password-change UI (see caveat above).
- Did not apply the RLS grant-tightening `revoke` statements recommended
  in the cross-tenant audit — unrelated to this item, still pending
  separately.
