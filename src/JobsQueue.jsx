import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

// A job is inside its "claim window" for the first hour after it's
// created. After that, if it's still unclaimed, the missed-lead
// escalation cron (api/check-missed-leads.js) has fired or is about to --
// the row is highlighted red here to match.
const CLAIM_WINDOW_MINUTES = 60;

function minutesSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / 60000;
}

export default function JobsQueue() {
  const { employee } = useAuth();
  const [jobs, setJobs] = useState([]);
  const [employeesById, setEmployeesById] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [claimingId, setClaimingId] = useState(null);

  const load = useCallback(async () => {
    setError('');
    const { data: jobRows, error: jobErr } = await supabase
      .from('jobs')
      .select('id, created_at, customer_name, customer_phone, customer_email, ai_job_type, ai_urgency, ai_summary, ai_watch_out, status, claimed_by, claimed_at')
      .order('created_at', { ascending: false });

    if (jobErr) {
      setError('Could not load jobs: ' + jobErr.message);
      setLoading(false);
      return;
    }
    setJobs(jobRows || []);

    const { data: employeeRows } = await supabase
      .from('employees')
      .select('id, full_name, role');
    const map = {};
    (employeeRows || []).forEach((e) => { map[e.id] = e; });
    setEmployeesById(map);

    setLoading(false);
  }, []);

  useEffect(() => {
    load();

    // Live updates: new submissions and claims from other dispatchers
    // show up without a manual refresh. Realtime respects the same RLS
    // policies as normal queries, so this only ever delivers rows this
    // employee's company can already see.
    const channel = supabase
      .channel('jobs-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, () => {
        load();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const handleClaim = async (jobId) => {
    setClaimingId(jobId);
    const { error: claimErr } = await supabase
      .from('jobs')
      .update({ claimed_by: employee.id, claimed_at: new Date().toISOString() })
      .eq('id', jobId)
      .is('claimed_by', null); // avoid a race where two people claim at once
    if (claimErr) {
      setError('Could not claim job: ' + claimErr.message);
    }
    await load();
    setClaimingId(null);
  };

  const unclaimedCount = jobs.filter((j) => !j.claimed_by).length;

  return (
    <div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }}
      className="font-sans p-8">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-2">
          <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
          <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-lg font-bold tracking-[0.15em]">SCOPE</span>
        </div>
        <Link to="/dashboard" style={{ color: '#C4C4C4' }} className="text-sm">Back to dashboard</Link>
      </div>

      <div className="flex items-center gap-3 mb-1">
        <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold">
          Jobs
        </h1>
        {unclaimedCount > 0 && (
          <span style={{ backgroundColor: '#E8BD3A', color: '#0A0A0A' }} className="text-xs font-bold px-2.5 py-1 rounded-full">
            {unclaimedCount} new
          </span>
        )}
      </div>
      <p style={{ color: '#C4C4C4' }} className="text-sm mb-6">
        Claim a job to stop the missed-lead clock. Unclaimed jobs past one hour are flagged and an alert email goes out.
      </p>

      {error && <p style={{ color: '#E07A6E' }} className="text-sm mb-4">{error}</p>}

      {loading ? (
        <p style={{ color: '#C4C4C4' }} className="text-sm">Loading…</p>
      ) : jobs.length === 0 ? (
        <p style={{ color: '#C4C4C4' }} className="text-sm">No jobs yet.</p>
      ) : (
        <div className="space-y-3">
          {jobs.map((j) => {
            const age = minutesSince(j.created_at);
            const isUnclaimed = !j.claimed_by;
            const isOverdue = isUnclaimed && age >= CLAIM_WINDOW_MINUTES;
            const claimedByName = j.claimed_by ? (employeesById[j.claimed_by]?.full_name || 'Someone') : null;

            const borderColor = isOverdue ? '#E07A6E' : isUnclaimed ? '#C9A227' : '#2A2A2A';
            const bgColor = isOverdue ? '#221414' : isUnclaimed ? '#1E1A0A' : '#161616';

            return (
              <div
                key={j.id}
                style={{ backgroundColor: bgColor, border: `1px solid ${borderColor}` }}
                className="rounded-lg p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p style={{ color: '#EDEAE3' }} className="text-sm font-semibold">
                        {j.ai_job_type || 'Job'}
                      </p>
                      <UrgencyBadge level={j.ai_urgency} />
                      {isOverdue && (
                        <span style={{ backgroundColor: '#3A1414', color: '#E07A6E', border: '1px solid #4A1F1A' }}
                          className="text-[11px] font-semibold px-2 py-0.5 rounded-full">
                          Missed lead risk
                        </span>
                      )}
                    </div>
                    <p style={{ color: '#9A9A9A' }} className="text-xs mt-1">
                      {new Date(j.created_at).toLocaleString()} · {Math.floor(age)} min ago
                    </p>
                    {(j.customer_name || j.customer_phone || j.customer_email) && (
                      <p style={{ color: '#C4C4C4' }} className="text-xs mt-2">
                        {j.customer_name || 'Unknown name'}
                        {j.customer_phone ? ` · ${j.customer_phone}` : ''}
                        {j.customer_email ? ` · ${j.customer_email}` : ''}
                      </p>
                    )}
                    {j.ai_summary && (
                      <p style={{ color: '#D8D8D8' }} className="text-sm mt-2 leading-relaxed">{j.ai_summary}</p>
                    )}
                    {j.ai_watch_out && (
                      <p style={{ color: '#9A9A9A' }} className="text-xs mt-1 italic">Watch out for: {j.ai_watch_out}</p>
                    )}
                  </div>
                  <div className="shrink-0">
                    {isUnclaimed ? (
                      <button
                        onClick={() => handleClaim(j.id)}
                        disabled={claimingId === j.id}
                        style={{ backgroundColor: '#E8BD3A', color: '#0A0A0A' }}
                        className="text-xs font-semibold px-3 py-1.5 rounded-md"
                      >
                        {claimingId === j.id ? 'Claiming…' : 'Claim'}
                      </button>
                    ) : (
                      <span style={{ color: '#7DA888' }} className="text-xs">
                        Claimed by {claimedByName}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );
}

function UrgencyBadge({ level }) {
  const styles = {
    High: { backgroundColor: '#2A1212', color: '#E07A6E', border: '1px solid #4A1F1A' },
    Medium: { backgroundColor: '#241C0A', color: '#D9B84A', border: '1px solid #3A2F0E' },
    Low: { backgroundColor: '#142018', color: '#7DA888', border: '1px solid #1F3026' },
  };
  return (
    <span style={styles[level] || styles.Medium} className="text-[11px] px-2 py-0.5 rounded-full font-medium">
      {level || 'Medium'}
    </span>
  );
}
