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
// Required env vars (set in Vercel project settings):
//   VITE_SUPABASE_URL          (already set, reused here)
//   SUPABASE_SERVICE_ROLE_KEY  (new -- Settings > API > service_role in Supabase)
//   RESEND_API_KEY             (new -- from resend.com, free tier)
//   CRON_SECRET                (new -- any random string you generate)

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

      if (emails.length > 0) {
        const ageMinutes = Math.floor((Date.now() - new Date(job.created_at).getTime()) / 60000);
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            // Resend's shared sandbox sender -- works with no domain setup.
            // Swap for a verified address on your own domain once you've
            // added one in Resend.
            from: 'Scope Alerts <onboarding@resend.dev>',
            to: emails,
            subject: `Missed lead: ${job.ai_job_type || 'a job'} unclaimed for ${ageMinutes} min`,
            html: `
              <p><strong>A job has gone unclaimed for over an hour.</strong></p>
              <p>${job.ai_job_type || 'Job'} — ${job.ai_urgency || 'Medium'} urgency</p>
              <p>Customer: ${job.customer_name || 'Unknown'} ${job.customer_phone ? '· ' + job.customer_phone : ''} ${job.customer_email ? '· ' + job.customer_email : ''}</p>
              <p>Submitted ${ageMinutes} minutes ago.</p>
              <p><a href="https://scope-intake.vercel.app/jobs">Open the jobs queue</a></p>
            `,
          }),
        });
      }

      // Mark alerted regardless of whether we found recipients -- an
      // empty employees table for this company shouldn't cause this job
      // to be retried forever on every cron run.
      await fetch(`${supabaseUrl}/rest/v1/jobs?id=eq.${job.id}`, {
        method: 'PATCH',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ missed_lead_alert_sent_at: new Date().toISOString() }),
      });

      alerted += 1;
    }

    return res.status(200).json({ checked: overdueJobs.length, alerted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
