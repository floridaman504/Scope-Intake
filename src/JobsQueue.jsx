import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';
import { colors, fontHead, STATUS_LABELS, STATUS_ORDER } from './theme.js';
import JobAssignment, { AssigneeBadge } from './JobAssignment.jsx';
import JobNotes from './JobNotes.jsx';

// A job is inside its "claim window" for the first hour after it's
// created. After that, if it's still unclaimed, the missed-lead
// escalation cron (api/check-missed-leads.js) has fired or is about to --
// the row is highlighted red here to match.
const CLAIM_WINDOW_MINUTES = 60;

function minutesSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / 60000;
}

// task #41 (dispatcher dashboard, assignment/status/notes/search): this
// page now serves three different roles with three different jobs to do,
// per the task #24 follow-on requirements --
//   - owner / dispatcher: full queue. Assign jobs to a specific plumber
//     (never self-claim), change status, leave notes, search/filter
//     across every job in the company. Owner can always reassign an
//     already-assigned job at any time -- the old owner-only-once-assigned
// lock and its matching DB trigger were removed on 2026-08-09 (see
// JobAssignment.jsx). Cancelling and reinstating a job (status dropdown)
// are open to both too. Deleting a job outright is owner-only.
//     (jobs_select_company's RLS doesn't itself restrict this -- any
//     employee can SELECT any of their company's jobs -- so the
//     "plumber only sees their own" scoping below is a deliberate
//     UI-layer choice, not something the database enforces for them).
//     No assign control, no status control, no notes (job_notes RLS is
//     owner/dispatcher only -- see JobNotes.jsx), just their job list
//     with search.
//
// NOTE ON "search by address": jobs has no address/service-location
// column at all today (checked the production schema -- intake collects
// context/fixture/pipe/access/cutting/preference/leak_detection/pets, but
// never a street address). Search below covers name/phone/email/job
// type/summary -- everything that actually exists. Flagged for Dante
// rather than silently dropped; adding a real address field is a small
// follow-up (new column + one more intake-form step) if he wants it.
export default function JobsQueue() {
  const { employee } = useAuth();
  const role = employee?.role;
  const isManager = role === 'owner' || role === 'dispatcher';
  const isOwner = role === 'owner';

  const [jobs, setJobs] = useState([]);
  const [employeesById, setEmployeesById] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const [search, setSearch] = useState('');
  const [statusFilters, setStatusFilters] = useState(
    () => new Set(STATUS_ORDER.filter((s) => s !== 'cancelled'))
  );
  const [assigneeFilter, setAssigneeFilter] = useState('all'); // 'all' | 'unassigned' | employeeId

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
      .select('id, full_name, role, email');
    const map = {};
    (employeeRows || []).forEach((e) => { map[e.id] = e; });
    setEmployeesById(map);

    setLoading(false);
  }, []);

  useEffect(() => {
    load();

    // Live updates: new submissions, assignments, and status/note changes
    // from other dispatchers show up without a manual refresh. Realtime
    // respects the same RLS policies as normal queries, so this only ever
    // delivers rows this employee's company can already see.
    const channel = supabase
      .channel('jobs-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, () => {
        load();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const plumbers = useMemo(
    () => Object.values(employeesById).filter((e) => e.role === 'plumber'),
    [employeesById]
  );

  const visibleJobs = useMemo(() => {
    let list = jobs;

    // Plumbers: hard-scoped to their own assigned jobs regardless of any
    // filter UI -- this is the "not browsing everyone else's jobs" rule,
    // not just a default.
    if (role === 'plumber') {
      list = list.filter((j) => j.claimed_by === employee?.id);
    } else {
      if (assigneeFilter === 'unassigned') {
        list = list.filter((j) => !j.claimed_by);
      } else if (assigneeFilter !== 'all') {
        list = list.filter((j) => j.claimed_by === assigneeFilter);
      }
    }

    list = list.filter((j) => statusFilters.has(j.status || 'new'));

    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((j) => {
        const assigneeName = j.claimed_by ? (employeesById[j.claimed_by]?.full_name || '') : '';
        const haystack = [
          j.customer_name, j.customer_phone, j.customer_email,
          j.ai_job_type, j.ai_summary, assigneeName,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    return list;
  }, [jobs, role, employee, assigneeFilter, statusFilters, search, employeesById]);

  const toggleStatusFilter = (status) => {
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status); else next.add(status);
      return next;
    });
  };

  const handleStatusChange = async (jobId, newStatus) => {
    setError('');
    const { error: updateErr } = await supabase
      .from('jobs')
      .update({ status: newStatus })
      .eq('id', jobId);
    if (updateErr) {
      setError('Could not update status: ' + updateErr.message);
      return;
    }
    await load();
  };

  // Owner-only, irreversible. jobs_delete_owner_company RLS backs this up
  // server-side (dispatcher/plumber DELETEs are rejected regardless of
  // what the UI shows), but the button itself is also gated to isOwner so
  // a dispatcher never sees a control that would just error out.
  const handleDelete = async (job) => {
    const label = job.customer_name || job.ai_job_type || 'this job';
    const confirmed = window.confirm(
      `Permanently delete ${label}? This can't be undone -- the job and its notes will be gone for good. If you just want it off the active list, use Cancel instead.`
      );
    if (!confirmed) return;

    setError('');
    setDeletingId(job.id);
    const { error: deleteErr } = await supabase
    .from('jobs')
    .delete()
    .eq('id', job.id);
    setDeletingId(null);
    if (deleteErr) {
      setError('Could not delete job: ' + deleteErr.message);
      return;
    }
    if (expandedId === job.id) setExpandedId(null);
    await load();
  };

  const unclaimedCount = jobs.filter((j) => !j.claimed_by && j.status !== 'cancelled').length;

  return (
    <div style={{ backgroundColor: colors.bg, color: colors.text, minHeight: '100vh' }}
      className="font-sans p-4 sm:p-8">
      <div className="flex items-center justify-between mb-6 sm:mb-8">
        <div className="flex items-center gap-2">
          <div style={{ backgroundColor: colors.gold }} className="w-2 h-2 rounded-full" />
          <span style={{ ...fontHead }} className="text-lg font-bold tracking-[0.15em]">SCOPE</span>
        </div>
        <Link to="/dashboard" style={{ color: colors.muted }} className="text-sm py-2">Back to dashboard</Link>
      </div>

      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 style={{ ...fontHead, color: colors.textBright }} className="text-2xl font-bold">
          {isManager ? 'Jobs' : 'My Jobs'}
        </h1>
        {isManager && unclaimedCount > 0 && (
          <span style={{ backgroundColor: colors.goldBright, color: colors.bg }} className="text-xs font-bold px-2.5 py-1 rounded-full">
            {unclaimedCount} unassigned
          </span>
        )}
      </div>
      <p style={{ color: colors.muted }} className="text-sm mb-5">
        {isManager
          ? 'Assign each job to a plumber to stop the missed-lead clock. Unassigned jobs past one hour are flagged and an alert email goes out.'
          : 'Jobs currently assigned to you.'}
      </p>

      {/* Search + filters */}
      <div style={{ backgroundColor: colors.panel, border: `1px solid ${colors.border}` }}
        className="rounded-lg p-3 sm:p-4 mb-5 space-y-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by client, phone, email, job type…"
          style={{ backgroundColor: colors.panelAlt, color: colors.text, border: `1px solid ${colors.borderLight}` }}
          className="w-full text-base rounded-md px-3 py-2.5"
        />

        <div className="flex flex-wrap gap-2">
          {STATUS_ORDER.map((s) => {
            const active = statusFilters.has(s);
            return (
              <button
                key={s}
                onClick={() => toggleStatusFilter(s)}
                style={{
                  backgroundColor: active ? colors.goldBright : colors.panelAlt,
                  color: active ? colors.bg : colors.muted,
                  border: `1px solid ${active ? colors.goldBright : colors.borderLight}`,
                }}
                className="text-sm font-medium px-3 py-2 rounded-full"
              >
                {STATUS_LABELS[s]}
              </button>
            );
          })}
        </div>

        {isManager && (
          <div className="flex items-center gap-2">
            <label style={{ color: colors.faint }} className="text-xs font-semibold uppercase tracking-wide shrink-0">
              Assigned to
            </label>
            <select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              style={{ backgroundColor: colors.panelAlt, color: colors.text, border: `1px solid ${colors.borderLight}` }}
              className="text-base rounded-md px-3 py-2.5 flex-1 sm:flex-none sm:min-w-[200px]"
            >
              <option value="all">Everyone</option>
              <option value="unassigned">Unassigned</option>
              {plumbers.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name || p.email}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {error && <p style={{ color: colors.danger }} className="text-sm mb-4">{error}</p>}

      {loading ? (
        <p style={{ color: colors.muted }} className="text-sm">Loading…</p>
      ) : visibleJobs.length === 0 ? (
        <p style={{ color: colors.muted }} className="text-sm">No jobs match.</p>
      ) : (
        <div className="space-y-3">
          {visibleJobs.map((j) => {
            const age = minutesSince(j.created_at);
            const isUnclaimed = !j.claimed_by;
            const isOverdue = isManager && isUnclaimed && j.status !== 'cancelled' && age >= CLAIM_WINDOW_MINUTES;
            const isExpanded = expandedId === j.id;

            const borderColor = isOverdue ? colors.danger : isUnclaimed ? colors.gold : colors.border;
            const bgColor = isOverdue ? colors.dangerBg : isUnclaimed ? '#1E1A0A' : colors.panel;

            return (
              <div
                key={j.id}
                style={{ backgroundColor: bgColor, border: `1px solid ${borderColor}` }}
                className="rounded-lg p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p style={{ color: colors.text }} className="text-sm font-semibold">
                        {j.ai_job_type || 'Job'}
                      </p>
                      <UrgencyBadge level={j.ai_urgency} />
                      <StatusBadge status={j.status} />
                      <AssigneeBadge name={j.claimed_by ? (employeesById[j.claimed_by]?.full_name || 'Unknown') : null} />
                      {isOverdue && (
                        <span style={{ backgroundColor: colors.dangerBg, color: colors.danger, border: `1px solid ${colors.dangerBorder}` }}
                          className="text-[11px] font-semibold px-2 py-0.5 rounded-full">
                          Missed lead risk
                        </span>
                      )}
                    </div>
                    <p style={{ color: colors.faint }} className="text-xs mt-1">
                      {new Date(j.created_at).toLocaleString()} · {Math.floor(age)} min ago
                    </p>
                    {(j.customer_name || j.customer_phone || j.customer_email) && (
                      <p style={{ color: colors.muted }} className="text-xs mt-2">
                        {j.customer_name || 'Unknown name'}
                        {j.customer_phone ? ` · ${j.customer_phone}` : ''}
                        {j.customer_email ? ` · ${j.customer_email}` : ''}
                      </p>
                    )}
                    {j.ai_summary && (
                      <p style={{ color: '#D8D8D8' }} className="text-sm mt-2 leading-relaxed">{j.ai_summary}</p>
                    )}
                    {j.ai_watch_out && (
                      <p style={{ color: colors.faint }} className="text-xs mt-1 italic">Watch out for: {j.ai_watch_out}</p>
                    )}

                    {isManager && isExpanded && (
                      <div className="mt-3 space-y-3">
                        <div>
                          <label style={{ color: colors.faint }} className="text-xs font-semibold uppercase tracking-wide block mb-1.5">
                            Status
                          </label>
                          <select
                            value={j.status || 'new'}
                            onChange={(e) => handleStatusChange(j.id, e.target.value)}
                            style={{ backgroundColor: colors.panelAlt, color: colors.text, border: `1px solid ${colors.borderLight}` }}
                            className="text-base rounded-md px-3 py-2.5"
                          >
                            {STATUS_ORDER.map((s) => (
                              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label style={{ color: colors.faint }} className="text-xs font-semibold uppercase tracking-wide block mb-1.5">
                            Assignment
                          </label>
                          <JobAssignment
                            job={j}
                            role={role}
                            plumbers={plumbers}
                            employeesById={employeesById}
                            onChanged={load}
                          />
                        </div>

                        <JobNotes jobId={j.id} employee={employee} employeesById={employeesById} />

                        {isOwner && (
                        <div className="pt-1">
                        <button
                          onClick={() => handleDelete(j)}
                          disabled={deletingId === j.id}
                          style={{ color: colors.danger, border: `1px solid ${colors.dangerBorder}` }}
                          className="text-sm font-semibold px-3 py-2 rounded-md"
                          >
                          {deletingId === j.id ? 'Deleting…' : 'Delete job'}
                        </button>
                        </div>
                    )}
                  </div>
                )}

                  {isManager && (
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : j.id)}
                      style={{ color: colors.gold, border: `1px solid ${colors.borderLight}` }}
                      className="shrink-0 text-sm font-semibold px-3 py-2.5 rounded-md"
                    >
                      {isExpanded ? 'Close' : 'Details'}
                    </button>
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
    High: { backgroundColor: '#2A1212', color: colors.danger, border: `1px solid ${colors.dangerBorder}` },
    Medium: { backgroundColor: '#241C0A', color: '#D9B84A', border: '1px solid #3A2F0E' },
    Low: { backgroundColor: colors.successBg, color: colors.success, border: `1px solid ${colors.successBorder}` },
  };
  return (
    <span style={styles[level] || styles.Medium} className="text-[11px] px-2 py-0.5 rounded-full font-medium">
      {level || 'Medium'}
    </span>
  );
}

function StatusBadge({ status }) {
  const s = status || 'new';
  const styles = {
    new: { backgroundColor: '#1C1C1C', color: colors.muted, border: `1px solid ${colors.borderLight}` },
    assigned: { backgroundColor: colors.infoBg, color: colors.info, border: `1px solid ${colors.infoBorder}` },
    in_progress: { backgroundColor: '#241C0A', color: '#D9B84A', border: '1px solid #3A2F0E' },
    done: { backgroundColor: colors.successBg, color: colors.success, border: `1px solid ${colors.successBorder}` },
    cancelled: { backgroundColor: '#1C1C1C', color: colors.faint, border: `1px solid ${colors.borderLight}` },
  };
  return (
    <span style={styles[s]} className="text-[11px] px-2 py-0.5 rounded-full font-medium">
      {STATUS_LABELS[s]}
    </span>
  );
}
