# Error handling (Tier 2, item #3 of docs/scope-operational-playbook.md)

## The problem, in plain terms

Whenever something went wrong -- a database rule got violated, a network
call failed, an AI request errored out -- a lot of places in this app took
the raw technical error message and showed it straight to whoever was
looking at the screen, or sent it back in an API response. That's a
problem for two reasons: it can leak internal details (database table
names, security-rule names, internal wording) to someone who shouldn't see
them, and it's also just confusing -- a plumber staring at "duplicate key
value violates unique constraint" has no idea what that means or what to
do next.

21 locations were doing this, found by re-auditing the actual current code
(not guessing from the earlier rough estimate). Two of them are the most
serious: `api/review-job.js`, the AI job-review endpoint, is public and has
no login gate -- anyone who can reach the website (or just hits the
endpoint directly with a tool like curl, no browser needed) could see
whatever raw error came back. The other 19 are in the logged-in
dispatcher/owner/plumber screens and the public sign-up/password-reset
pages -- lower exposure since most require a valid login, but still a real
leak if an account is ever compromised or misused.

## The fix

Two small shared helper files, one for each side of the app, so every
error response goes through the same rule instead of each of the 21 spots
deciding for itself:

- **`api/_lib/errorResponse.js`** (`sendSafeError`) -- for the two Vercel
  serverless functions (`api/review-job.js`, `api/check-missed-leads.js`).
  Logs the real error to Vercel's own server-side logs (never sent to
  anyone's browser) and sends back a safe, generic message in the HTTP
  response instead. The filename starts with `_` on purpose -- that's
  Vercel's own signal that a file under `api/` is a shared helper, not a
  new public endpoint.
- **`src/errorMessages.js`** (`logSafeError`) -- for the React screens.
  Logs the real error to the browser's own console (visible only to
  whoever's already looking at that screen -- the same visibility any
  other client-side debugging already has, and genuinely useful if someone
  needs to report a bug) and returns a safe, still-specific-to-what-failed
  message to actually show on screen -- e.g. "Could not load employees.
  Please try again." instead of a raw Postgres error.

Every one of the 21 spots was changed to call one of these two helpers
instead of touching `err.message` directly. Nothing about *when* an error
is shown changed -- only *what text* gets shown.

## Verification

Full test suite (139 tests) and a production build both run clean. Three
existing tests that had been asserting on the exact raw error text
(`Join.test.jsx` x2, `ResetPassword.test.jsx` x1) were updated to expect
the new safe message instead -- that was an intentional behavior change,
not a regression, so those tests were rewritten rather than left broken.
Two new test files (`src/errorMessages.test.js`,
`api/_lib/errorResponse.test.js`) directly confirm the raw error text
never appears in either helper's return value, plus new cases in
`api/check-missed-leads.test.js` and `api/review-job.test.js` confirm the
same for the two API endpoints specifically.
