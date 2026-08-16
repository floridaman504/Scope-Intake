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
//
// Also writes to the durable error_log table (Tier 2 #10, "Error Handling
// Rebuild" -- docs/migrations/2026-08-16-error-log-pipeline.sql), the same
// real error the console.error above already gets. Deliberately NOT
// awaited and kept out of this function's own signature/return value --
// every one of this file's ~20 call sites depends on logSafeError being a
// plain synchronous function that returns the fallback string immediately
// for setError(...); making this async would mean touching every one of
// them. The browser (unlike a Vercel serverless function) keeps running
// this fetch to completion in the background even after logSafeError
// returns, so fire-and-forget is safe here in a way it isn't server-side
// (see api/_lib/errorResponse.js's logAppError for why that side awaits).
//
// The import is dynamic, not a top-level `import { supabase } from
// './supabaseClient.js'`, on purpose: creating that client throws if the
// Supabase env vars aren't set (real in this app's own Vitest environment,
// which doesn't set them), and errorMessages.js is imported by nearly
// every screen in the app -- a throw at module-load time here would break
// every one of their test files, not just this one's. A dynamic import
// only evaluates supabaseClient.js when logSafeError actually runs, and
// the .catch below swallows a construction failure the same way it
// swallows a network failure -- logging must never itself break anything.
function logToErrorPipeline(fallback, err) {
  import('./supabaseClient.js')
    .then(({ supabase }) =>
      supabase.rpc('log_app_error', {
        p_severity: 'error',
        p_source: 'client:ui',
        p_route: typeof window !== 'undefined' ? window.location.pathname : null,
        p_http_method: null,
        p_message: fallback,
        p_detail: err?.stack || err?.message || String(err),
      })
    )
    .catch(() => {}); // best-effort; a logging failure must never surface to the user
}

export function logSafeError(context, err, fallback) {
  console.error(context, err);
  logToErrorPipeline(fallback, err);
  return fallback;
}
