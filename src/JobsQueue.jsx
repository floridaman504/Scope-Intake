import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';
import { colors, fontHead, STATUS_LABELS, STATUS_ORDER } from './theme.js';
import JobAssignment, { AssigneeBadge } from './JobAssignment.jsx';
import JobNotes from './JobNotes.jsx';
import { logSafeError } from './errorMessages.js';

// A job is inside its "claim window" for the first hour after it's
// created. After that, if it's still unclaimed, the missed-lead
// escalation cron (api/check-missed-leads.js) has fired or is about to --
// the row is highlighted red here to match.
const CLAIM_WINDOW_MINUTES = 60;

function minutesSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / 60000;
}

// 2026-08-13 (jobs-view redesign, phase 1 -- list/agenda first, calendar
// grid deferred to a later phase per Dante's own pick between the two
// options). Groups jobs by scheduled_start for the agenda view. Unscheduled
// jobs surface first (they're the ones that need a dispatcher's attention),
// then Today/Tomorrow/This week/Later, then anything in the past. `now` is
// a parameter (not Date.now() inline) purely so this is deterministic to
// unit test.
const AGENDA_GROUP_ORDER = ['Unscheduled', 'Today', 'Tomorrow', 'This week', 'Later', 'Past'];

export function scheduleGroupFor(job, now = new Date()) {
  if (!job.scheduled_start) return 'Unscheduled';
  const start = new Date(job.scheduled_start);
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((startDay - today) / 86400000);
  if (diffDays < 0) return 'Past';
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays <= 7) return 'This week';
  return 'Later';
}

// <input type="datetime-local"> works in the browser's local timezone and
// expects/returns "YYYY-MM-DDTHH:mm" with no offset -- these two helpers
// are the only place that boundary is crossed, everywhere else in this
// file scheduled_start/scheduled_end stay as UTC ISO strings (what's
// actually stored in Postgres).
function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocalValue(localValue) {
  if (!localValue) return null;
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
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
//     No assign control, no status control, just their job list with
//     search. (2026-08-13: plumbers now DO get notes -- see below.)
//
// 2026-08-13 (jobs-view redesign): time-window scheduling + plumber/owner
// duration, confirmed with Dante after two rounds of competitor research.
//   - scheduled_start/scheduled_end: owner/dispatcher only, via the
//     existing raw jobs UPDATE they already have (jobs_update_owner_
//     dispatcher_company). Independent from duration by design -- setting
//     one never moves the other (see 2026-08-13-job-scheduling-window-and-
//     duration.sql for the full reasoning).
//   - estimated_duration_minutes: owner or an assigned plumber only, via
//     the new set_job_duration RPC -- dispatcher has no UI control for it
//     AND is blocked at the DB level (jobs_before_update_duration_scope_
//     lock trigger), not just hidden in the UI.
//   - job_notes: plumbers can now read+write notes on jobs they're
//     assigned to (2026-08-13-job-notes-plumber-access.sql), and job_notes
//     is now in the supabase_realtime publication, so a plumber's note
//     shows up for the owner/dispatcher instantly and vice versa -- see
//     JobNotes.jsx for the realtime subscription itself.
//   - The "Details" expand affordance is no longer isManager-only --
//     plumbers get it too, scoped to jobs they're already restricted to
//     seeing via visibleJobs above, so there's no new exposure.
//   - Agenda grouping (Unscheduled/Today/Tomorrow/This week/Later/Past,
//     see scheduleGroupFor above) replaces the flat list for every role.
//     This is the "list/agenda first" option Dante picked over building a
//     full drag-and-drop calendar grid immediately -- that's flagged as a
//     clearly-scoped phase 2, not attempted here.
//
// task (2026-08-10, multi-assignee / "buddy work"): a job can now have
// more than one assignee -- any mix of plumbers and/or the owner --
// tracked in the job_assignees junction table instead of a single
// jobs.claimed_by column. jobs.claimed_by/claimed_at are kept in sync by
// a DB trigger as the "primary" (earliest-assigned) assignee, purely for
// backward compatibility with the missed-lead cron. This component now
// fetches job_assignees alongside jobs/employees and treats it as the
// source of truth for "who's assigned," "is this job unassigned," and
// plumbers' "is this my job" scoping -- claimed_by is no longer read
// directly anywhere in this file.
//
// NOTE ON "search by address": jobs has no address/service-location
// column at all today (checked the production schema -- intake collects
// context/fixture/pipe/access/cutting/preference/leak_detection/pets, but
// never a street address). Search below covers name/phone/email/job
// type/summary/assignee names -- everything that actually exists.
// Flagged for Dante rather than silently dropped; adding a real address
// field is a small follow-up (new column + one more intake-form step) if
// he wants it.
export default function JobsQueue() {
  const { employee } = useAuth();
  const role = employee?.role;
  const isManager = role === 'owner' || role === 'dispatcher';
  const isOwner = role === 'owner';

  const [jobs, setJobs] = useState([]);
  const [employeesById, setEmployeesById] = useState({});
  const [assigneesByJob, setAssigneesByJob] = useState({}); // { [jobId]: [employeeId, ...] }, ordered by assigned_at
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
      .select('id, created_at, customer_name, customer_phone, customer_email, ai_job_type, ai_urgency, ai_summary, ai_watch_out, status, media, scheduled_start, scheduled_end, estimated_duration_minutes')
      .order('created_at', { ascending: false });

    if (jobErr) {
      setError(logSafeError('Could not load jobs:', jobErr, 'Could not load jobs. Please try again.'));
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

    // job_assignees RLS scopes this to the caller's own company already
    // (via a join back to jobs.company_id), same as jobs itself -- no
    // extra company filter needed here.
    const { data: assigneeRows, error: assigneeErr } = await supabase
      .from('job_assignees')
      .select('job_id, employee_id, assigned_at')
      .order('assigned_at', { ascending: true });
    if (assigneeErr) {
      setError(logSafeError('Could not load assignments:', assigneeErr, 'Could not load assignments. Please try again.'));
      setLoading(false);
      return;
    }
    const byJob = {};
    (assigneeRows || []).forEach((row) => {
      if (!byJob[row.job_id]) byJob[row.job_id] = [];
      byJob[row.job_id].push(row.employee_id);
    });
    setAssigneesByJob(byJob);

    setLoading(false);
  }, []);

  useEffect(() => {
    load();

    // Live updates: new submissions, assignment changes, and status/note
    // changes from other dispatchers show up without a manual refresh.
    // Assignment changes now land in job_assignees rather than jobs, so
    // this subscribes to both tables. Realtime respects the same RLS
    // policies as normal queries, so this only ever delivers rows this
    // employee's company can already see.
    const channel = supabase
      .channel('jobs-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, () => {
        load();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_assignees' }, () => {
        load();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [load]);

  // Assignable pool for the "add assignee" control: plumbers and/or the
  // owner, per the buddy-work requirement -- dispatchers coordinate jobs
  // but aren't themselves assigned to do the fieldwork.
  const assignableEmployees = useMemo(
    () => Object.values(employeesById).filter((e) => e.role === 'plumber' || e.role === 'owner'),
    [employeesById]
  );

  const visibleJobs = useMemo(() => {
    let list = jobs;

    // Plumbers: hard-scoped to jobs they're assigned to (as primary OR
    // buddy) regardless of any filter UI -- this is the "not browsing
    // everyone else's jobs" rule, not just a default.
    if (role === 'plumber') {
      list = list.filter((j) => (assigneesByJob[j.id] || []).includes(employee?.id));
    } else {
      if (assigneeFilter === 'unassigned') {
        list = list.filter((j) => (assigneesByJob[j.id] || []).length === 0);
      } else if (assigneeFilter !== 'all') {
        list = list.filter((j) => (assigneesByJob[j.id] || []).includes(assigneeFilter));
      }
    }

    list = list.filter((j) => statusFilters.has(j.status || 'new'));

    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((j) => {
        const assigneeNames = (assigneesByJob[j.id] || [])
          .map((id) => employeesById[id]?.full_name || '')
          .join(' ');
        const haystack = [
          j.customer_name, j.customer_phone, j.customer_email,
          j.ai_job_type, j.ai_summary, assigneeNames,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    // Agenda ordering: group first (unscheduled surfaces first -- those
    // are the ones needing a dispatcher's attention), then by
    // scheduled_start within a group, then fall back to the original
    // newest-first order for jobs with no schedule at all.
    list = [...list].sort((a, b) => {
      const ga = AGENDA_GROUP_ORDER.indexOf(scheduleGroupFor(a));
      const gb = AGENDA_GROUP_ORDER.indexOf(scheduleGroupFor(b));
      if (ga !== gb) return ga - gb;
      if (a.scheduled_start && b.scheduled_start) {
        return new Date(a.scheduled_start) - new Date(b.scheduled_start);
      }
      if (a.scheduled_start) return -1;
      if (b.scheduled_start) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    return list;
  }, [jobs, role, employee, assigneeFilter, statusFilters, search, employeesById, assigneesByJob]);

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
      setError(logSafeError('Could not update status:', updateErr, 'Could not update status. Please try again.'));
      return;
    }
    await load();
  };

  // Owner/dispatcher only in the UI -- backed up by the existing
  // jobs_update_owner_dispatcher_company RLS policy (plumbers have no raw
  // UPDATE grant on jobs at all, so this would fail server-side for them
  // regardless of what the UI shows).
  const handleScheduleChange = async (jobId, field, localValue) => {
    setError('');
    const { error: updateErr } = await supabase
      .from('jobs')
      .update({ [field]: fromDatetimeLocalValue(localValue) })
      .eq('id', jobId);
    if (updateErr) {
      setError(logSafeError('Could not update schedule:', updateErr, 'Could not update schedule. Please try again.'));
      return;
    }
    await load();
  };

  // Owner or an assigned plumber only -- enforced by set_job_duration
  // itself (SECURITY DEFINER, checks role + job_assignees membership) and
  // by jobs_before_update_duration_scope_lock, which blocks a dispatcher
  // from setting this column even via a raw update. Never call
  // .from('jobs').update({ estimated_duration_minutes }) directly.
  const handleDurationChange = async (jobId, minutesValue) => {
    setError('');
    const minutes = minutesValue === '' ? null : parseInt(minutesValue, 10);
    if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0)) {
      setError('Duration must be a positive number of minutes');
      return;
    }
    const { error: rpcErr } = await supabase.rpc('set_job_duration', { p_job_id: jobId, p_minutes: minutes });
    if (rpcErr) {
      setError(logSafeError('Could not update duration:', rpcErr, 'Could not update duration. Please try again.'));
      return;
    }
    await load();
  };

  // Owner-only, irreversible. jobs_delete_owner_company RLS backs this up
  // server-side (dispatcher/plumber DELETEs are rejected regardless of
  // what the UI shows), but the button itself is also gated to isOwner so
  // a dispatcher never sees a control that would just error out. Deleting
  // a job cascades to job_assignees (on delete cascade), so buddy
  // assignments don't need separate cleanup here.
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
      setError(logSafeError('Could not delete job:', deleteErr, 'Could not delete job. Please try again.'));
      return;
    }
    if (expandedId === job.id) setExpandedId(null);
    await load();
  };

  const unclaimedCount = jobs.filter((j) => (assigneesByJob[j.id] || []).length === 0 && j.status !== 'cancelled').length;

  // Mutated inside the visibleJobs.map() below to detect when the agenda
  // group changes so a header only renders once per group. Local to this
  // render call (redeclared fresh every render), not persisted state.
  let lastGroup = null;

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
          ? 'Assign each job to one or more plumbers to stop the missed-lead clock. Unassigned jobs past one hour are flagged and an alert email goes out.'
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
              {assignableEmployees.map((e) => (
                <option key={e.id} value={e.id}>{e.full_name || e.email}{e.role === 'owner' ? ' (owner)' : ''}</option>
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
            const assigneeIds = assigneesByJob[j.id] || [];
            const isUnclaimed = assigneeIds.length === 0;
            const isOverdue = isManager && isUnclaimed && j.status !== 'cancelled' && age >= CLAIM_WINDOW_MINUTES;
            const isExpanded = expandedId === j.id;

            const borderColor = isOverdue ? colors.danger : isUnclaimed ? colors.gold : colors.border;
            const bgColor = isOverdue ? colors.dangerBg : isUnclaimed ? '#1E1A0A' : colors.panel;

            const group = scheduleGroupFor(j);
            const showGroupHeader = group !== lastGroup;
            lastGroup = group;
            // Plumbers only ever see jobs they're assigned to (visibleJobs
            // already hard-filters this above), so "expanded + plumber"
            // always means "expanded + my own job" -- no extra per-job
            // assignment check needed here for gating notes/media/duration.
            const canSeeDetails = isManager || role === 'plumber';

            return (
              <React.Fragment key={j.id}>
                {showGroupHeader && (
                  <div style={{ color: colors.faint }} className="text-xs font-bold uppercase tracking-widest mt-5 mb-1 first:mt-0">
                    {group}
                  </div>
                )}
              <div
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
                      {assigneeIds.length === 0 ? (
                        <AssigneeBadge name={null} />
                      ) : (
                        assigneeIds.map((id) => (
                          <AssigneeBadge key={id} name={employeesById[id]?.full_name || 'Unknown'} />
                        ))
                      )}
                      {isOverdue && (
                        <span style={{ backgroundColor: colors.dangerBg, color: colors.danger, border: `1px solid ${colors.dangerBorder}` }}
                          className="text-[11px] font-semibold px-2 py-0.5 rounded-full">
                          Missed lead risk
                        </span>
                      )}
                      {j.estimated_duration_minutes && (
                        <span style={{ backgroundColor: colors.panelAlt, color: colors.muted, border: `1px solid ${colors.borderLight}` }}
                          className="text-[11px] font-semibold px-2 py-0.5 rounded-full">
                          ~{j.estimated_duration_minutes} min
                        </span>
                      )}
                    </div>
                    <p style={{ color: colors.faint }} className="text-xs mt-1">
                      {new Date(j.created_at).toLocaleString()} · {Math.floor(age)} min ago
                    </p>
                    {j.scheduled_start && (
                      <p style={{ color: colors.gold }} className="text-xs mt-1 font-medium">
                        Scheduled: {new Date(j.scheduled_start).toLocaleString()}
                        {j.scheduled_end ? ` – ${new Date(j.scheduled_end).toLocaleTimeString()}` : ''}
                      </p>
                    )}
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

                    {canSeeDetails && isExpanded && (
                      <div className="mt-3 space-y-3">
                        {isManager && (
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
                        )}

                        {isManager && (
                        <div>
                          <label style={{ color: colors.faint }} className="text-xs font-semibold uppercase tracking-wide block mb-1.5">
                            Assignment
                          </label>
                          <JobAssignment
                            job={j}
                            role={role}
                            assignableEmployees={assignableEmployees}
                            currentAssigneeIds={assigneeIds}
                            employeesById={employeesById}
                            onChanged={load}
                          />
                        </div>
                        )}

                        {isManager && (
                        <div>
                          <label style={{ color: colors.faint }} className="text-xs font-semibold uppercase tracking-wide block mb-1.5">
                            Scheduled window
                          </label>
                          <div className="flex flex-col sm:flex-row gap-2">
                            <input
                              type="datetime-local"
                              value={toDatetimeLocalValue(j.scheduled_start)}
                              onChange={(e) => handleScheduleChange(j.id, 'scheduled_start', e.target.value)}
                              style={{ backgroundColor: colors.panelAlt, color: colors.text, border: `1px solid ${colors.borderLight}` }}
                              className="text-base rounded-md px-3 py-2.5 flex-1"
                            />
                            <input
                              type="datetime-local"
                              value={toDatetimeLocalValue(j.scheduled_end)}
                              onChange={(e) => handleScheduleChange(j.id, 'scheduled_end', e.target.value)}
                              style={{ backgroundColor: colors.panelAlt, color: colors.text, border: `1px solid ${colors.borderLight}` }}
                              className="text-base rounded-md px-3 py-2.5 flex-1"
                            />
                          </div>
                          <p style={{ color: colors.faint }} className="text-[11px] mt-1">
                            This is the calendar window only. It's independent from the duration
                            below -- the assigned plumber (or you) sets that separately once they
                            know how long the job will actually take.
                          </p>
                        </div>
                        )}

                        {(isOwner || role === 'plumber') && (
                        <div>
                          <label style={{ color: colors.faint }} className="text-xs font-semibold uppercase tracking-wide block mb-1.5">
                            Estimated duration (minutes)
                          </label>
                          <input
                            type="number"
                            min="1"
                            defaultValue={j.estimated_duration_minutes || ''}
                            onBlur={(e) => handleDurationChange(j.id, e.target.value)}
                            placeholder="e.g. 45"
                            style={{ backgroundColor: colors.panelAlt, color: colors.text, border: `1px solid ${colors.borderLight}` }}
                            className="text-base rounded-md px-3 py-2.5 w-32"
                          />
                          <p style={{ color: colors.faint }} className="text-[11px] mt-1">
                            Only you or the owner can set this -- the dispatcher can't guess how
                            long a job will take, so they never see this control.
                          </p>
                        </div>
                        )}

                        {j.media?.length > 0 && <JobMedia media={j.media} />}

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

                  {canSeeDetails && (
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
              </React.Fragment>
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

// Renders a job's attached photos/videos. The `job-media` bucket is
// private (see docs/migrations/2026-08-12-job-media-storage-bucket.sql) --
// its SELECT policy only allows a signed URL to be minted for an
// employee whose own company_id matches the object's path, mirroring
// jobs_select_company. Signed URLs are fetched lazily here (only once a
// job is expanded), not for every row in the list, and are short-lived
// (1 hour) rather than cached indefinitely.
function JobMedia({ media }) {
  const [signedUrls, setSignedUrls] = useState({}); // { [path]: url | 'error' }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        media.map(async (m) => {
          if (!m.path) return [m.path, 'error'];
          const { data, error } = await supabase.storage
            .from('job-media')
            .createSignedUrl(m.path, 3600);
          return [m.path, error ? 'error' : data.signedUrl];
        })
      );
      if (!cancelled) setSignedUrls(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [media]);

  return (
    <div>
      <label style={{ color: colors.faint }} className="text-xs font-semibold uppercase tracking-wide block mb-1.5">
        Attachments
      </label>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {media.map((m, i) => {
          const url = m.path ? signedUrls[m.path] : undefined;
          return (
            <div key={i} style={{ backgroundColor: colors.panelAlt, border: `1px solid ${colors.borderLight}` }}
              className="aspect-square rounded-md overflow-hidden flex items-center justify-center">
              {!m.path || url === 'error' ? (
                <span style={{ color: colors.faint }} className="text-[10px] text-center px-1">
                  {!m.path ? 'Not uploaded' : 'Unavailable'}
                </span>
              ) : !url ? (
                <span style={{ color: colors.faint }} className="text-[10px]">Loading…</span>
              ) : m.type === 'image' ? (
                <a href={url} target="_blank" rel="noreferrer" className="w-full h-full">
                  <img src={url} alt={m.name || `Attachment ${i + 1}`} className="w-full h-full object-cover" />
                </a>
              ) : (
                <a href={url} target="_blank" rel="noreferrer" style={{ color: colors.gold }} className="text-[11px] text-center px-1 underline">
                  View video
                </a>
              )}
            </div>
          );
        })}
      </div>
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
