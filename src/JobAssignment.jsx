import React, { useState } from 'react';
import { supabase } from './supabaseClient.js';
import { colors } from './theme.js';

// Multi-assignee control for a single job. Plumbing work is often done in
// pairs/crews ("buddy work"), so a job can have more than one assignee --
// any mix of plumbers and/or the owner (per Dante, 2026-08-10: "the
// dispatcher will at times need to add any multiple plumbers that exist
// at the company per owner request to any different job"). Assignment
// now lives in the job_assignees junction table rather than a single
// jobs.claimed_by column.
//
// A DB trigger (sync_jobs_claimed_by_from_assignees, see
// docs/migrations/2026-08-10-job-assignees-multi-assignee.sql) keeps
// jobs.claimed_by/claimed_at mirroring the earliest-assigned row as a
// "primary assignee" for backward compatibility with anything that still
// reads claimed_by directly -- most importantly the missed-lead cron's
// claimed_by=is.null check, which is still correct unmodified because
// claimed_by is NULL if and only if job_assignees has zero rows for the
// job.
//
// Deliberately NOT a self-claim control -- plumbers never see this
// component at all (JobsQueue only renders it for owner/dispatcher), and
// dispatchers assign jobs TO people rather than claiming for themselves.
// Both owner and dispatcher can freely add/remove assignees at any time
// -- there is no assignment lock (see JobsQueue.jsx's comment for the
// history there).
export default function JobAssignment({ job, role, assignableEmployees, currentAssigneeIds, employeesById, onChanged }) {
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [busyId, setBusyId] = useState(null); // employee id currently being added/removed, or 'add' while inserting
  const [error, setError] = useState('');

  const canAssignAtAll = role === 'owner' || role === 'dispatcher';
  if (!canAssignAtAll) return null;

  const currentAssignees = currentAssigneeIds
    .map((id) => employeesById[id])
    .filter(Boolean);

  const available = assignableEmployees.filter((e) => !currentAssigneeIds.includes(e.id));

  const addAssignee = async () => {
    if (!selectedId) {
      setError('Pick someone to add first.');
      return;
    }
    setBusyId('add');
    setError('');
    const wasUnassigned = currentAssigneeIds.length === 0;
    const { error: insertErr } = await supabase
      .from('job_assignees')
      .insert({ job_id: job.id, employee_id: selectedId });
    if (insertErr) {
      setBusyId(null);
      setError(insertErr.message);
      return;
    }
    // First assignee on a brand-new job also nudges status out of "new",
    // matching the old single-assignee flow's behavior. The job_assignees
    // insert above already updated jobs.claimed_by/claimed_at via the sync
    // trigger -- this second call only handles status, which the trigger
    // deliberately doesn't touch.
    if (wasUnassigned && job.status === 'new') {
      await supabase.from('jobs').update({ status: 'assigned' }).eq('id', job.id);
    }
    setBusyId(null);
    setSelectedId('');
    setAdding(false);
    onChanged();
  };

  const removeAssignee = async (employeeId) => {
    setBusyId(employeeId);
    setError('');
    const { error: deleteErr } = await supabase
      .from('job_assignees')
      .delete()
      .eq('job_id', job.id)
      .eq('employee_id', employeeId);
    setBusyId(null);
    if (deleteErr) {
      setError(deleteErr.message);
      return;
    }
    onChanged();
  };

  return (
    <div className="flex flex-col gap-2 mt-2">
      <div className="flex items-center gap-2 flex-wrap">
        {currentAssignees.length === 0 ? (
          <AssigneeBadge name={null} />
        ) : (
          currentAssignees.map((e) => (
            <span key={e.id} className="inline-flex items-center gap-1">
              <AssigneeBadge name={e.full_name || e.email} />
              <button
                onClick={() => removeAssignee(e.id)}
                disabled={busyId === e.id}
                title={`Remove ${e.full_name || e.email}`}
                style={{ color: colors.muted }}
                className="text-xs px-1"
              >
                {busyId === e.id ? '…' : '✕'}
              </button>
            </span>
          ))
        )}
      </div>

      {adding ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            style={{ backgroundColor: colors.panelAlt, color: colors.text, border: `1px solid ${colors.borderLight}` }}
            className="text-base rounded-md px-3 py-2.5 min-w-[180px]"
          >
            <option value="">Select a plumber or owner…</option>
            {available.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name || e.email}{e.role === 'owner' ? ' (owner)' : ''}
              </option>
            ))}
          </select>
          <button
            onClick={addAssignee}
            disabled={busyId !== null}
            style={{ backgroundColor: colors.goldBright, color: colors.bg }}
            className="text-sm font-semibold px-4 py-2.5 rounded-md"
          >
            {busyId === 'add' ? 'Adding…' : 'Confirm'}
          </button>
          <button
            onClick={() => { setAdding(false); setSelectedId(''); setError(''); }}
            style={{ color: colors.muted }}
            className="text-sm px-2 py-2.5"
          >
            Cancel
          </button>
        </div>
      ) : (
        available.length > 0 && (
          <button
            onClick={() => setAdding(true)}
            style={{ backgroundColor: colors.goldBright, color: colors.bg }}
            className="text-sm font-semibold px-4 py-2.5 rounded-md self-start"
          >
            {currentAssignees.length === 0 ? 'Assign to plumber…' : '+ Add another'}
          </button>
        )
      )}

      {error && <p style={{ color: colors.danger }} className="text-xs mt-1">{error}</p>}
    </div>
  );
}

// Exported so JobsQueue can show the same badge style in the collapsed
// card view too, without duplicating styling. JobsQueue calls this once
// per current assignee (for the "multiple plumbers badged to the job"
// requirement), plus once for "Unassigned" when a job has none.
export function AssigneeBadge({ name }) {
  if (!name) {
    return (
      <span
        style={{ backgroundColor: colors.dangerBg, color: colors.danger, border: `1px solid ${colors.dangerBorder}` }}
        className="text-xs font-semibold px-2.5 py-1 rounded-full"
      >
        Unassigned
      </span>
    );
  }
  return (
    <span
      style={{ backgroundColor: colors.infoBg, color: colors.info, border: `1px solid ${colors.infoBorder}` }}
      className="text-xs font-semibold px-2.5 py-1 rounded-full"
    >
      👤 {name}
    </span>
  );
}
