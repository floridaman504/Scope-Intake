# Login Flow Test Suite — 2026-08-06

## What this answers

Tier 1 item 5 (the last item in the Tier 1 audit): a test suite for the
login flow, per the playbook -- "test successful login, failed login with
wrong password, account lockout after 5 failed attempts, password reset
flow, and session creation." Also: run tests on every commit, fail under a
coverage threshold, and split unit tests (every push) from integration
tests (PRs and merges).

## The one thing to read first: two playbook items don't apply

The playbook asks for tests of **account lockout after 5 failed attempts**
and a **password reset flow**. Checked `Login.jsx`, `Join.jsx`,
`AuthContext.jsx`, and did a repo-wide grep for `lockout`, `resetPassword`,
`forgot`, `failed_attempt`, `lock_until`, `max_attempts` -- nothing. **Neither
feature exists in this codebase.** Login is a plain
`supabase.auth.signInWithPassword` call with no attempt counter, no lockout
state, and no UI or code path for resetting a password (there's no "forgot
password" link, no `resetPasswordForEmail` call anywhere, nothing).

Per the brief for this task: writing tests for either would mean asserting
behavior that doesn't exist, which is worse than no tests -- a green suite
for a feature that was never built would tell you the opposite of the
truth. **So this suite does not test lockout or password reset.** This is a
missing *feature*, not a missing *test*, and it's a real product gap worth
flagging on its own: right now, an attacker (or a bot) can attempt
unlimited password guesses against any known email with zero friction, and
a user who forgets their password has no self-service way to recover the
account -- Dante would have to manually reset it via the Supabase dashboard
or a SQL update. Neither is this ticket's scope to fix (this ticket is
"write tests for the login flow," not "build lockout and reset"), but it
should go on the product backlog, ideally before Tier 1 gets called "done"
in spirit rather than in the narrow audit-item sense.

Everything else the playbook asked for -- successful login, failed login
with wrong password, session creation -- does exist and is tested below,
along with the parts of the actual login/signup/session code that exist
today but weren't in the original playbook bullet list (invite-code
signup, role-based route access, the Tier 1.3 session-hardening layer).

## What's tested

Test framework: **Vitest + React Testing Library**, chosen because this is
already a Vite project (`@vitejs/plugin-react` is already a dependency) --
Vitest reuses the exact same Vite config/transform pipeline the app
already builds with, so there's no second bundler or config system to
maintain.

### Unit tests (`npm run test:unit` -- runs on every push)

- **`src/Login.test.jsx`** (12 tests) -- successful login (calls
  `signInWithPassword`, redirects to `/dashboard`), failed login with wrong
  password (generic "Incorrect email or password." shown, real Supabase
  error text never leaked to the UI, password field keeps its value),
  loading/disabled-button state during the request, empty-field and
  malformed-email HTML5 validation blocking submission before it reaches
  Supabase at all, the session-expired banner (`?expired=1&reason=...`) for
  both a known and an unrecognized reason code, and the post-login
  restore-snapshot redirect (including the open-redirect guard for a
  `//evil.example.com`-shaped snapshot path, and an expired/stale snapshot
  being ignored).
- **`src/Join.test.jsx`** (12 tests) -- successful signup + invite-code
  redemption redirect, invite code trimmed before redemption, signUp itself
  failing (e.g. "already registered"), the email-confirmation-required
  branch (signup succeeds but no session yet, so the invite code is
  deliberately *not* redeemed until they confirm and log in), an invalid
  invite code, an already-used invite code, a message-less RPC error
  falling back to a generic message, an unexpected thrown error, and
  required-field / malformed-email validation.
- **`src/ProtectedRoute.test.jsx`** (9 tests) -- loading state, redirect to
  `/login` when unauthenticated, the restore-snapshot write on
  unauthenticated direct access (and that it doesn't clobber an existing
  one), unrestricted routes rendering for any authenticated user, role
  allow-listing (owner/dispatcher allowed, plumber blocked, with the
  access-denied message), and the edge case of a session existing but the
  employee row not having loaded yet. `useAuth()` is mocked directly here
  rather than going through a real `AuthProvider`, so this file tests
  `ProtectedRoute`'s own logic in isolation.
- **`src/AuthContext.test.jsx`** (10 tests) -- employee row loading (and
  the null-on-error case), the Tier 1.3 session registry: registering a
  new session via `register_session` on first load, reusing a
  `sessionStorage`-cached session id via `touch_session` instead of
  re-registering, re-registering if the cached id comes back invalid, and
  the **fail-open behavior when `register_session` errors** -- this
  matters because `supabase_session_hardening.sql` (the Tier 1.3 migration)
  **has not been applied to production**, so this is the actual behavior
  production is running today, not a hypothetical. Also covers `signOut`
  (calls `revoke_session` then `supabase.auth.signOut`, clears local
  state), `signOutEverywhere`, and reacting to an externally-triggered
  `SIGNED_OUT` auth state change (refresh token rejected elsewhere) by
  clearing state and saving a restore snapshot.

### Integration tests (`npm run test:integration` -- runs on PRs and merges to main)

- **`src/test/integration/loginFlow.test.jsx`** (7 tests) -- the real
  `Login` + `AuthProvider` + `ProtectedRoute` wired together the way
  `main.jsx` wires them, driven by actual typing/clicking rather than
  calling internal functions directly: unauthenticated direct access to
  `/dashboard` bounces to `/login`; a full successful login (including the
  `onAuthStateChange('SIGNED_IN', ...)` callback Supabase fires for real)
  lands on the dashboard; a wrong password never reaches it; owner and
  dispatcher can reach `/dashboard`, plumber cannot and sees the
  access-denied message, and plumber *can* reach `/sessions` (which allows
  all three roles) -- covering the actual role matrix from `main.jsx`, not
  a hypothetical one.
- **`src/test/integration/sessionExpiry.test.jsx`** (2 tests) -- the Tier
  1.3 sliding-expiry warning modal and forced sign-out, using
  `vi.useFakeTimers()` so the test doesn't run for real minutes: shows
  "Still there?" inside the warning window, then (with no interaction)
  signs out and redirects to `/login?expired=1&reason=inactivity_timeout`
  with the matching banner text once the configured lifetime elapses;
  clicking "Stay signed in" extends the session and the warning does not
  reappear at the original deadline. `max_lifetime_minutes` is set to a
  short value via the mocked `session_policy` table rather than changing
  any real constant, so the test exercises the real timing logic in
  `AuthContext.jsx`/`sessionConfig.js`, just compressed.

  One thing worth flagging for whoever touches routing later: this test
  had to render `<MemoryRouter>` *without* the `v7_startTransition` future
  flag. With it on, two competing `navigate()` calls that fire close
  together (`AuthContext`'s explicit navigate-with-query-string inside
  `forceSignOut`, and `ProtectedRoute`'s own `<Navigate>` reacting to
  `session` becoming `null`) can reorder under React's `startTransition`
  batching, and the plain `/login` navigation (no `?expired=...` query) can
  win the race, silently dropping the expiry reason from the URL. This
  only surfaced because fake timers collapse what's normally minutes of
  real time into milliseconds -- I could not get it to reproduce with real
  timers in manual testing. Flagging it rather than "fixing" it, since
  fixing it would mean touching `AuthContext.jsx`/`ProtectedRoute.jsx`,
  which is out of scope for a test-suite ticket; if `v7_startTransition` is
  ever turned on in `main.jsx`, this ordering is worth re-checking for
  real.

### Mocking approach

`src/test/mocks/supabaseMock.js` is a hand-built mock of the app's own
`src/supabaseClient.js` module (not a network-level stub) -- every test
does `vi.mock('./supabaseClient.js', ...)` to swap in a fake client whose
`auth.*`, `.from().select()...`, `.rpc()`, and `.channel()` calls are all
`vi.fn()`s with scriptable responses (`setTableResponse`, `setRpcResponse`,
`fireAuthStateChange`). **No test in this suite makes a real network
call.** Nothing here can reach `etpzprrroxjjroisboui.supabase.co`, and
nothing needs Supabase credentials to run -- confirmed by running the full
suite with no `.env` file present at all.

## Real coverage, from an actual run

Coverage is scoped to the files this suite targets (`Login.jsx`,
`Join.jsx`, `AuthContext.jsx`, `ProtectedRoute.jsx`, `sessionConfig.js`,
`activityTracking.js`, `SessionExpiryWarning.jsx`) -- not the whole app.
`ScopeIntake.jsx`, `Dashboard.jsx`, and `SessionRegistry.jsx` are unrelated
features outside this ticket's scope and would only dilute the number.

Full suite (`npm run test:coverage`, unit + integration together), actual
output:

```
 Test Files  6 passed (6)
      Tests  52 passed (52)

 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   89.47 |    79.03 |      85 |   94.03 |
 AuthContext.jsx   |    89.7 |    79.64 |   86.84 |   91.71 | ...60,369-370,384
 Join.jsx          |     100 |      100 |     100 |     100 |
 Login.jsx         |     100 |       95 |     100 |     100 | 41
 ProtectedRoute.jsx|     100 |      100 |     100 |     100 |
 SessionExpiryWarning.jsx | 83.33 | 100 |      50 |      80 | 49
 activityTracking.js|  80.76 |        0 |    62.5 |      90 | 34-35
 sessionConfig.js  |   72.72 |       50 |     100 |     100 | 41-57
-------------------|---------|----------|---------|---------|-------------------

Statements   : 89.47% ( 306/342 )
Branches     : 79.03% ( 147/186 )
Functions    : 85% ( 51/60 )
Lines        : 94.03% ( 284/302 )
```

Uncovered lines are mostly the `changePasswordAndSignOutEverywhere`
function (no "change password" UI exists yet to call it -- same category
as the lockout/reset gap above, a not-yet-built feature, not a test gap),
`parseDeviceLabel`'s less common browser/OS branches, and a couple of
`catch` blocks around `sessionStorage`/realtime-channel failures that are
awkward to force in jsdom without mocking browser internals more invasively
than seemed worth it for this ticket.

## Coverage threshold: not the playbook's literal 60%

The playbook says "fail the build if coverage drops below 60%." Actual
achieved coverage on the full suite (89/79/85/94%) is well above that, so
`vitest.config.js` sets thresholds with headroom under the *real* numbers
rather than either the arbitrary 60% floor or gaming the number up to
exactly what was achieved:

```
lines: 85, statements: 80, functions: 75, branches: 65
```

This is strict enough to catch a real regression (e.g. someone deleting
half the AuthContext tests) while leaving room for normal future changes
to these files without spuriously failing CI over a point or two.

**One deliberate deviation from "on every commit":** the coverage
*percentage* gate only runs where the full suite (unit + integration) runs
-- pull requests and pushes to `main` -- not on every feature-branch push.
Reason: the unit suite alone (no integration tests) covers ~79% statements
/ 66% branches / 75% functions / 83% lines -- comfortably above the
playbook's original 60%, but below the tighter thresholds above, which
were set against the *combined* number. Every push still gets full
pass/fail test feedback (`npm run test:unit` in CI); what's gated to
PR/merge specifically is the percentage check, since that's the only point
where the full picture exists.

## CI wiring (`.github/workflows/test.yml`)

Three jobs:

- **`unit-tests`** -- every push to any branch except `main` (merges to
  `main` are covered by the job below). Runs `npm run test:unit`.
- **`integration-tests`** -- pull requests and pushes to `main`. Runs
  `npm run test:integration`.
- **`coverage`** -- pull requests and pushes to `main`. Runs
  `npm run test:coverage` (full suite, thresholds enforced by
  `vitest.config.js` -- a failing threshold fails this job, same as the
  gitleaks/backup workflows). Uploads the HTML coverage report as a build
  artifact so it can be opened without running anything locally.

No repo secrets are needed for this workflow -- confirmed by running with
no `.env` present.

## Running it locally

```
npm install
npm test               # unit + integration together, once
npm run test:unit      # unit only
npm run test:integration  # integration only
npm run test:coverage  # full suite + coverage report + threshold check
npm run test:watch     # watch mode while developing
```

`src/test/setup.js` is the global Vitest setup (jest-dom matchers, RTL
cleanup between tests, `sessionStorage`/`localStorage` cleared between
tests). `src/test/mocks/supabaseMock.js` is the shared Supabase mock.
`src/test/utils.jsx` has a `renderWithProviders` helper used by the unit
tests that need a real `AuthProvider` + router context (`Login.test.jsx`,
`Join.test.jsx`, `AuthContext.test.jsx`).

## What's deliberately NOT covered by this ticket

- **Account lockout after failed attempts** -- doesn't exist. See above.
- **Password reset flow** -- doesn't exist. See above.
- **"Change password" UI** -- `AuthContext.jsx` has
  `changePasswordAndSignOutEverywhere` ready for one, but no page calls it
  yet (see the comment in `AuthContext.jsx` itself). Not tested via a UI
  flow for the same reason -- there's no UI to test yet -- though the
  function itself is partially exercised indirectly through the `signOut`
  tests' shared code path.
- **Cross-tenant / RLS behavior** -- covered by Tier 1.2's audit, out of
  scope here (this ticket is the login *flow*, not authorization data
  boundaries).
- **The `SessionRegistry.jsx` page** ("your active sessions" /
  "manage team sessions" UI) -- not part of the login flow itself; would be
  reasonable to add its own test file as a follow-up, not bundled into this
  ticket.
