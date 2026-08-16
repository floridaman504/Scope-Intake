// Missed-lead escalation. Finds jobs that have sat unclaimed past the
// one-hour claim window and haven't already been alerted on, emails the
// company's owner/dispatcher, and marks the alert as sent so it doesn't
// fire twice.
//
// This runs on Vercel (server-side, never in the browser) so it can use
// the Supabase SERVICE ROLE key, which bypasses RLS -- it needs to see
// every company's unclaimed jobs, not just one company scoped by a
// logged-in user's session.
//
// Triggered by a GitHub Actions scheduled workflow (not Vercel Cron --
// the Hobby plan caps Vercel Cron at once/day, which is useless for a
// one-hour escalation window). The workflow calls this endpoint every
// few minutes with a shared secret so randoms on the internet can't
// trigger it.
//
// escapeHtml: job fields interpolated into the alert email body below
// (customer_name, ai_job_type, etc.) all originate from the public,
// unauthenticated intake form -- nothing stops a customer from typing
// `<img src=x onerror=alert(1)>` as their name. This endpoint used to
// interpolate those values into the email's `html` field completely raw
// (Tier 2 #9 audit finding, docs/scope-operational-playbook.md) -- a
// stored HTML/script injection into whatever mail client the
// owner/dispatcher reads the alert in. Escaping the five HTML metacharacters
// is enough here since these values only ever land inside plain <p> text
// content below, never inside an attribute or a <script> context.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// MULTI-ASSIGNEE NOTE (2026-08-10): assignment moved from a single
// jobs.claimed_by column to a job_assignees junction table (a job can now
// have multiple plumbers and/or the owner assigned -- "buddy work"). This
// endpoint was deliberately left unchanged: a DB trigger
// (sync_jobs_claimed_by_from_assignees, see
// docs/migrations/2026-08-10-job-assignees-multi-assignee.sql) keeps
// jobs.claimed_by/claimed_at mirroring the earliest-assigned row, so
// claimed_by is still NULL if and only if job_assignees has zero rows for
// the job -- the claimed_by=is.null filter below is exactly as correct
// for "truly unassigned" under multi-assignee as it was under
// single-assignee. If that trigger is ever removed, this query needs to
// switch to checking job_assignees directly.
//
// Required env vars (set in Vercel project settings):
//   VITE_SUPABASE_URL          (already set, reused here)
//   SUPABASE_SERVICE_ROLE_KEY  (new -- Settings > API > service_role in Supabase)
//   RESEND_API_KEY             (new -- from resend.com, free tier)
//   CRON_SECRET                (new -- any random string you generate)

import { sendSafeError } from './_lib/errorResponse.js';

const CLAIM_WINDOW_MINUTES = 60;

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const providedSecret = req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Missing Supabase server credentials' });
  }
  if (!resendKey) {
    return res.status(500).json({ error: 'Missing RESEND_API_KEY' });
  }

  try {
    const cutoff = new Date(Date.now() - CLAIM_WINDOW_MINUTES * 60 * 1000).toISOString();

    // Raw REST call to Supabase using the service role key -- avoids
    // pulling in @supabase/supabase-js just for two simple queries, and
    // keeps this function's only dependency on fetch, which Vercel's
    // Node runtime provides natively.
    const jobsRes = await fetch(
      `${supabaseUrl}/rest/v1/jobs?select=id,company_id,customer_name,customer_phone,customer_email,ai_job_type,ai_urgency,created_at&claimed_by=is.null&missed_lead_alert_sent_at=is.null&created_at=lt.${cutoff}`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      }
    );
    const overdueJobs = await jobsRes.json();

    if (!Array.isArray(overdueJobs) || overdueJobs.length === 0) {
      return res.status(200).json({ checked: 0, alerted: 0 });
    }

    let alerted = 0;
    let failed = 0;
    const failures = [];

    for (const job of overdueJobs) {
      // Recipients: owners and dispatchers at this job's company.
      const employeesRes = await fetch(
        `${supabaseUrl}/rest/v1/employees?select=email,full_name,role&company_id=eq.${job.company_id}&role=in.(owner,dispatcher)`,
        {
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
        }
      );
      const recipients = await employeesRes.json();
      const emails = (recipients || []).map((r) => r.email).filter(Boolean);

      // BUGFIX (2026-08-09): this used to fire the Resend request and mark
      // missed_lead_alert_sent_at unconditionally, without ever checking
      // whether the send actually succeeded. The first real run against
      // production found 13 overdue jobs, Resend rejected every send with
      // 403 (onboarding@resend.dev can only deliver to the account's own
      // address -- a verified sending domain is required for real
      // recipients), and all 13 got silently marked as "alerted" anyway.
      // No one was notified and the cron would never have retried them.
      // Now: only mark sent when there were no recipients to notify (that
      // case is intentionally not retried -- see below) or the send
      // request came back ok. A failed send leaves the row unmarked so
      // the next cron run tries again once the sender is fixed.
      let sendOk = true;
      if (emails.length > 0) {
        const ageMinutes = Math.floor((Date.now() - new Date(job.created_at).getTime()) / 60000);
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            // Resend's shared sandbox sender -- only deliverable to the
            // account's own address. Swap for a verified address on your
            // own domain in Resend before this can reach real recipients.
            from: 'Scope Alerts <alerts@mail.scopwell.com>',
            to: emails,
            // Subject line isn't HTML, but Resend/most mail clients render
            // it as plain text anyway -- escaping isn't needed there, only
            // in the html body below where a raw `<` or `&` would actually
            // be interpreted as markup.
            subject: `Missed lead: ${job.ai_job_type || 'a job'} unclaimed for ${ageMinutes} min`,
            html: `
              <p><strong>A job has gone unclaimed for over an hour.</strong></p>
              <p>${escapeHtml(job.ai_job_type) || 'Job'} — ${escapeHtml(job.ai_urgency) || 'Medium'} urgency</p>
              <p>Customer: ${escapeHtml(job.customer_name) || 'Unknown'} ${job.customer_phone ? '· ' + escapeHtml(job.customer_phone) : ''} ${job.customer_email ? '· ' + escapeHtml(job.customer_email) : ''}</p>
              <p>Submitted ${ageMinutes} minutes ago.</p>
              <p><a href="https://scope-intake.vercel.app/jobs">Open the jobs queue</a></p>
            `,
          }),
        });
        sendOk = emailRes.ok;
        if (!sendOk) {
          failed += 1;
          failures.push({ jobId: job.id, status: emailRes.status });
        }
      }

      // Mark alerted when there were no recipients to notify (an empty
      // employees table for this company shouldn't cause this job to be
      // retried forever on every cron run) or when the send succeeded.
      // A failed send with recipients present is left unmarked for retry.
      if (sendOk) {
        const markRes = await fetch(`${supabaseUrl}/rest/v1/jobs?id=eq.${job.id}`, {
          method: 'PATCH',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ missed_lead_alert_sent_at: new Date().toISOString() }),
        });
        // If this PATCH itself fails, the row is still unmarked -- the
        // next cron run will see it as overdue again and (if there were
        // recipients) send a second email. That's the same "occasionally
        // double-alert rather than silently never-alert" tradeoff the
        // BUGFIX above already accepts for send failures; this just makes
        // sure a failed mark-as-sent is counted and visible the same way
        // a failed send already is, instead of silently reporting success
        // for a write that didn't happen.
        if (markRes.ok) {
          alerted += 1;
        } else {
          failed += 1;
          failures.push({ jobId: job.id, status: markRes.status, stage: 'mark_alerted' });
        }
      }
    }

    return res.status(200).json({ checked: overdueJobs.length, alerted, failed, failures });
  } catch (err) {
    // This endpoint is secret-gated (see the x-cron-secret check above) and
    // only ever called by the scheduled workflow, not a customer -- but the
    // audit's policy is the same everywhere: no raw internal error text in
    // a response body. See api/_lib/errorResponse.js.
    return sendSafeError(res, 500, err, 'Internal error while checking for missed leads.');
  }
}
