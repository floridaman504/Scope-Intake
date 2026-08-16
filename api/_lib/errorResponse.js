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
// Logs the real error to the function's own server-side logs (Vercel's
// dashboard -- never sent to the client) and returns a safe, generic
// message in the response body instead.
export function sendSafeError(res, status, err, publicMessage) {
  console.error(publicMessage, err);
  return res.status(status).json({ error: publicMessage });
}
