// This file runs on Vercel's server, never in the customer's browser.
// Your API key stays private here and is never visible to anyone using the site.

import { createClient } from '@supabase/supabase-js';
import { sendSafeError } from './_lib/errorResponse.js';

// Server-side Supabase client using the anon key -- same key the browser
// uses. check_rate_limit() and log_ai_usage() are SECURITY DEFINER
// functions explicitly designed to be called by the anon role from an
// unauthenticated context (that's the whole point: this endpoint has no
// login gate, since a customer hasn't signed up for anything yet when
// they hit it). Safe to call from here with the anon key for the same
// reason it's safe to expose in the browser -- these two functions are
// the only thing anon is allowed to do with billing_guardrails/
// ai_usage_log at all.
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { summary, mediaCount, mediaTypes, subdomain } = req.body;

    // Input limits (Tier 2 #9 of docs/scope-operational-playbook.md).
    // This endpoint is public and unauthenticated, and `summary` gets
    // concatenated directly into the AI prompt below -- an unbounded value
    // here is both a prompt-injection surface and an unbounded-cost vector
    // (more input tokens = more spend, on an endpoint anyone can hit
    // repeatedly, ahead of check_rate_limit's own per-IP/per-company caps).
    // Rejecting outright (400) rather than silently truncating is
    // deliberate -- a truncated `summary` could produce a misleadingly
    // confident brief from a half-cut-off description, which is worse for
    // the plumber reading it than a clear "something's wrong, try again"
    // for the customer. 6000 chars comfortably covers the real form (7
    // answer fields, longest capped at 2000 chars client-side in
    // ScopeIntake.jsx, plus question-title prefixes) with room to spare.
    // mediaCount's cap of 8 matches the client-side attachment limit and
    // the jobs_media_count DB constraint (docs/migrations/2026-08-15-add-input-limits.sql)
    // -- three independent layers agreeing on the same number on purpose.
    if (typeof summary !== 'string' || summary.trim().length === 0) {
      return res.status(400).json({ error: 'summary is required' });
    }
    if (summary.length > 6000) {
      return res.status(400).json({ error: 'summary is too long' });
    }
    if (mediaCount !== undefined && mediaCount !== null) {
      if (!Number.isInteger(mediaCount) || mediaCount < 0 || mediaCount > 8) {
        return res.status(400).json({ error: 'mediaCount is invalid' });
      }
    }
    if (mediaTypes !== undefined && mediaTypes !== null) {
      if (typeof mediaTypes !== 'string' || mediaTypes.length > 200) {
        return res.status(400).json({ error: 'mediaTypes is invalid' });
      }
    }
    if (subdomain !== undefined && subdomain !== null) {
      if (typeof subdomain !== 'string' || subdomain.length > 100) {
        return res.status(400).json({ error: 'subdomain is invalid' });
      }
    }

    // Vercel sets x-forwarded-for to the real client IP (first entry if
    // the request passed through multiple proxies).
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown';

    // Cost guardrail, checked BEFORE calling Anthropic. This endpoint is
    // public and unauthenticated by design (a customer hasn't signed up
    // for anything when they hit it), which means it's also the one place
    // in this app where an unbounded, metered third-party cost could be
    // run up by anyone -- a bot in a loop, not just a real customer typing
    // slowly. check_rate_limit() and the billing_guardrails/ai_usage_log
    // tables it reads already existed in the schema before this endpoint
    // ever wired into them; this is closing that gap, not building new
    // infrastructure.
    //
    // Honest tradeoff, called out rather than buried: if this check
    // itself fails (Supabase down, network blip), we log it and let the
    // request proceed rather than block a real customer's submission over
    // an infra hiccup on a secondary system. The global daily cost cap is
    // still the backstop for a sustained abuse pattern once logging
    // resumes -- this fail-open only matters for the duration of an
    // actual Supabase outage, which is a different (and rarer) failure
    // mode than "someone is hammering this endpoint."
    const { data: limitCode, error: limitErr } = await supabase.rpc(
      'check_rate_limit',
      { p_subdomain: subdomain || null, p_ip: ip }
    );

    if (limitErr) {
      console.error('check_rate_limit call failed, proceeding (fail-open):', limitErr.message);
    } else if (limitCode) {
      // limitCode is one of: 'rate_limited_ip' | 'rate_limited_company' | 'global_cap_reached'
      return res.status(429).json({
        error: 'Too many requests right now. Please try again in a little while.',
        code: limitCode,
      });
    }

    const prompt = `You are an experienced plumbing dispatcher reviewing a customer's job intake submission. Based on the following information, produce a CONCISE job brief for the plumber who will be dispatched. Respond ONLY in JSON, no markdown, no preamble, with this exact shape:
{
  "jobType": "short label for the type of job",
  "urgency": "Low | Medium | High",
  "likelyMaterials": ["item1", "item2"],
  "briefSummary": "2-3 sentence summary a plumber can read in 10 seconds before a job",
  "watchOutFor": "one sentence on the biggest risk or thing to double check on site"
}

Customer submission:
${summary}
Media attached: ${mediaCount} file(s) (${mediaTypes})`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        // Switched from claude-sonnet-5 to claude-haiku-4-5 (2026-08-15)
        // after a 12-case head-to-head comparison
        // (scripts/compare-review-job-models.mjs) showed matching urgency
        // calls on every case, including the two safety-critical ones
        // (a gas-smell report and a sewage backup) -- while running
        // roughly 3x cheaper and 1.5-2s faster per call. Revert this one
        // line back to 'claude-sonnet-5' if real customer submissions ever
        // show it producing a visibly worse brief.
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      // Raw Anthropic error text (model/rate-limit internals) must not
      // reach the client -- see api/_lib/errorResponse.js.
      return await sendSafeError(res, 500, data.error, 'The AI service is temporarily unavailable. Please try again.', {
        source: 'api:review-job',
        route: '/api/review-job',
        method: req.method,
      });
    }

    // Log actual token usage regardless of what happens next -- this is
    // the spend that already happened, whether or not parsing the reply
    // succeeds below. Best-effort: a logging failure shouldn't turn a
    // successful AI response into an error for the customer.
    const usage = data.usage || {};
    const { error: logErr } = await supabase.rpc('log_ai_usage', {
      p_subdomain: subdomain || null,
      p_ip: ip,
      p_input_tokens: usage.input_tokens || 0,
      p_output_tokens: usage.output_tokens || 0,
    });
    if (logErr) {
      console.error('log_ai_usage call failed (usage not recorded):', logErr.message);
    }

    const text = data.content.map((b) => b.text || '').join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);
  } catch (err) {
    // Catch-all: could be a raw Supabase/Postgres error, a JSON.parse
    // failure, or any other internal exception -- none of it belongs in a
    // public response body. See api/_lib/errorResponse.js.
    return await sendSafeError(res, 500, err, 'Something went wrong processing your request. Please try again.', {
      source: 'api:review-job',
      route: '/api/review-job',
      method: req.method,
    });
  }
}
