// Centralized safe-error response helper (Tier 2 error-handling audit,
// docs/audits/2026-08-16-error-handling.md). api/review-job.js is public
// and unauthenticated -- it's called directly by the intake form's
// fetch(), so anyone with devtools or curl can see the raw HTTP response
// body, independent of whatever ScopeIntake.jsx chooses to render from it.
// Before this file existed, both of that endpoint's error paths returned
// `err.message` (or an upstream Anthropic error's `.message`) verbatim in
// the JSON body -- a real information-disclosure surface, not just a UX
// wart, since it's reachable by a request that never goes through the
// browser UI at all.
//
// Filename starts with an underscore so Vercel does NOT turn this into its
// own serverless function/route (Vercel's rule: files/folders starting
// with `_` under api/ are excluded from routing) -- this is a shared
// helper module, not an endpoint.
//
// logAppError (added alongside sendSafeError, Tier 2 #10, "Error Handling
// Rebuild" -- docs/migrations/2026-08-16-error-log-pipeline.sql): before
// this, the real error only ever reached console.error -- Vercel's own
// function logs, not part of this app's database, not searchable, and on
// Vercel's free tier not retained long. This writes the same real error
// into a durable, owner-only, 90-day-retained table instead, via a
// rate-limited SECURITY DEFINER RPC (same shape as job_submission_log's
// guardrail) so this new write path can't itself become an abuse surface.
// A raw fetch straight to Supabase's PostgREST RPC endpoint -- not
// @supabase/supabase-js -- so this file stays dependency-free and works
// the same way from api/check-missed-leads.js, which never instantiates a
// supabase-js client at all (see that file's own raw-fetch REST calls).
//
// Awaited, not fire-and-forget: a Vercel serverless function can be frozen
// the instant its response is sent, which would silently drop an
// un-awaited logging call more often than not. The extra round-trip only
// happens on error paths, never the happy path, so the latency cost is
// negligible against the value of not losing the log entry.
async function logAppError({ severity, source, route, httpMethod, message, detail }) {
  try {
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) return; // never let missing config break the actual error response

    await fetch(`${supabaseUrl}/rest/v1/rpc/log_app_error`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_severity: severity,
        p_source: source,
        p_route: route ?? null,
        p_http_method: httpMethod ?? null,
        p_message: message,
        p_detail: detail ?? null,
      }),
    });
  } catch (loggingErr) {
    // Logging the error must never become a NEW error. Falls back to the
    // same server-side console log this file has always produced.
    console.error('logAppError itself failed (non-fatal):', loggingErr);
  }
}

// Logs the real error to the function's own server-side logs AND the
// durable error_log table (both server-side only -- never sent to the
// client) and returns a safe, generic message in the response body
// instead. `context` is optional so existing call sites keep working
// unchanged; pass { route, method } to get route/method captured in
// error_log too.
export async function sendSafeError(res, status, err, publicMessage, context = {}) {
  console.error(publicMessage, err);
  await logAppError({
    severity: 'error',
    source: context.source || 'api',
    route: context.route,
    httpMethod: context.method,
    message: publicMessage,
    detail: err?.stack || err?.message || String(err),
  });
  return res.status(status).json({ error: publicMessage });
}

// Exported separately for the handled-but-not-thrown failure paths this
// audit's boundary-coverage pass found -- e.g.
// api/check-missed-leads.js's per-job Resend/mark-as-sent failures, which
// are already tracked in that function's own `failures` array and
// recovered from automatically (the next cron run retries), but were
// never visible anywhere a person would actually see them. Severity
// 'warning' fits that shape: not a crash, still worth an owner knowing
// about if it keeps happening.
export { logAppError };
