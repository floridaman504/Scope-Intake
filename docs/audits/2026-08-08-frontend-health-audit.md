# Frontend Health Audit — 2026-08-08

Scope: live production app at scope-intake.vercel.app. Goal was to find broken flows, dead code, accessibility gaps, error handling holes, and UX rough edges before real users hit them and file support messages.

## Headline finding: 13 real jobs are sitting unread in production

A read-only query against production (`select count(*), min(created_at), max(created_at) from public.jobs`) returned 13 rows, spanning 2026-06-30 through 2026-08-05. These are real customer job submissions that went through the intake form. There is currently no dashboard notification, email alert, or badge that tells you (or a dispatcher) that new jobs have landed — you only find them if you manually open `/dashboard` or `/sessions` and look. This is a product decision, not something I fixed unilaterally: do you want email/SMS alerts on new job insert, a badge count in the header, or something else? Worth deciding before the beta grows past a size where checking manually is realistic.

## Fixed now (low-risk, no product decision needed)

- **No 404 page.** Any unmatched route (typo'd link, stale bookmark, dead link from an old message) rendered a completely blank white page — no header, no message, nothing to click. Added a catch-all `<Route path="*">` wired to a new `NotFound.jsx` styled to match the rest of the app, with a "Go home" link back to `/`.
- **No error boundary.** A single unhandled render error anywhere in the tree would have blanked the entire app with no recovery path. Wrapped the app in a new `ErrorBoundary` component (`src/ErrorBoundary.jsx`) that catches render errors, logs them via `console.error`, and shows a "Something Went Wrong" screen with a "Reload page" button instead of a blank screen.
- **Missing aria-label on icon-only remove-media button.** The "x" button used to remove an uploaded photo/video in the intake form had no accessible name — a screen reader user would hear nothing useful. Added `aria-label="Remove photo N"` / `"Remove video N"`.
- **Non-descriptive alt text on uploaded photos.** Both the intake preview grid and the job-brief result screen used `alt=""` on uploaded photos, which is correct only for purely decorative images — these are the actual evidence photos the customer uploaded. Changed to `alt="Uploaded photo N of the issue"`.

## Found, not fixed — needs a product decision

- **Email-confirmation dead end.** If Supabase's "Confirm email" setting were ever turned on, a newly signed-up user would be sent a confirmation link but the app has no page/flow to handle a bounce-back from that link gracefully — they'd likely land somewhere confusing. This is currently dormant because Confirm Email is OFF in Supabase Auth settings, so it's not biting anyone today, but it's a landmine if that setting ever gets flipped on (e.g. for stricter security later).
- **Silent database-save failure on job submit.** In `ScopeIntake.jsx`, if the AI review call succeeds but the subsequent `supabase.from('jobs').insert()` call fails, the error is caught and logged to the console only — the customer sees a normal "success" job brief screen with no idea their job was never actually saved to the database. This is intentional-looking (comment says "we don't block the customer — they've done their part") but means silent data loss is possible with zero visibility unless someone's watching server logs.
- **"/sessions" naming overload.** The route `/sessions` is used for "job/session registry" (dispatcher-facing), which reads oddly next to auth "session" (login session) terminology used elsewhere in the codebase (e.g. `SessionExpiryWarning`). Not a bug, but worth a rename if it ever causes real confusion for new team members reading the code.
- **No confirmation on "Sign out everywhere."** This is a destructive, hard-to-undo action (kills all active sessions across devices) with no "are you sure?" step. Low risk given current usage patterns, but worth a confirm dialog before it's exposed to a wider set of users.

## What's already solid

- `SessionExpiryWarning` component has good accessibility basics (visible countdown, keyboard-reachable controls).
- Password visibility toggles on login/reset forms work correctly and are keyboard accessible.
- The AI-review-fails fallback UX (when `/api/review-job` errors) still shows the customer's raw answers in a usable format rather than a dead end.
- No console errors observed during a full manual click-through of the live app (intake flow, login, dashboard, sessions registry).
