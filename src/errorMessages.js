// Centralized user-facing error handling (Tier 2 error-handling audit,
// docs/audits/2026-08-16-error-handling.md). Before this file existed, ~15
// places across the authenticated dispatcher/owner/plumber UI and the
// public /join, /email-confirmed, and /reset-password pages built their
// error message by concatenating a raw Postgres/PostgREST/Supabase-Auth
// error string straight into what gets rendered (e.g.
// `'Could not load employees: ' + loadErr.message`). That's an information
// leak -- it can hand a constraint name, an RLS policy name, or internal
// wording to whoever's looking at the screen, which is useful to an
// attacker (including a compromised or malicious lower-privileged
// employee account) and just confusing/unhelpful to everyone else. It's
// not the same severity as the public review-job endpoint (see
// api/_lib/errorResponse.js for that side), but the fix is the same shape:
// never let a raw internal error string reach something rendered to a
// user.
//
// logSafeError(context, err, fallback) logs the real error to the
// browser's own console -- visible only to whoever is already looking at
// this screen, the same visibility any other client-side debugging
// already has, and genuinely useful for reporting a bug -- and returns a
// safe, still-specific-to-what-failed fallback message to actually show in
// the UI. Call sites just wrap their existing setError(...) argument with
// this instead of touching err.message directly.
export function logSafeError(context, err, fallback) {
  console.error(context, err);
  return fallback;
}
