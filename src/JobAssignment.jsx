import React, { useState } from 'react';
import { supabase } from './supabaseClient.js';
import { colors } from './theme.js';

// Assignment control for a single job. Deliberately NOT a self-claim
// button -- task #24/#41 requirement: plumbers can never self-assign
// (they never see this component at all -- JobsQueue only renders it for
// owner/dispatcher), and dispatchers assign a job TO a specific plumber
// rather than claiming it for themselves.
//
// Owner vs. dispatcher behavior once a job already has an assignee is
// enforced server-side by the jobs_before_update_assignment_lock trigger
// (2026-08-09-dispatcher-dashboard-pricing-estimator.sql): a dispatcher's
// UPDATE fails if it changes claimed_by on a job that already has one.
// This component mirrors that at the UI layer -- the "change assignee"
// control only renders for role === 'owner' once a job is assigned, so a
// dispatcher never sees a control that would just error out. If that
// trigger's rule ever changes, this is the one place the UI needs to
// follow it.
export default function JobAssignment({ job, role, plumbers, employeesById, onChanged }) {
  const [picking, setPicking] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canAssignAtAll = role === 'owner' || role === 'dispatcher';
  const isAssigned = !!job.claimed_by;
  const assigneeName = isAssigned ? (employeesById[job.claimed_by]?.full_name || 'Unknown') : null;

  // Dispatchers can assign an unclaimed job, but once it's assigned only
  // the owner can change WHO it's assigned to (see trigger note above).
  const canChangeAssignee = role === 'owner' || (role === 'dispatcher' && !isAssigned);

  if (!canAssignAtAll) return null;

  const startPicking = () => {
    setSelectedId(job.claimed_by || '');
    setError('');
    setPicking(true);
  };

  const submit = async () => {
    if (!selectedId) {
      setError('Pick a plumber first.');
      return;
    }
    setSaving(true);
    setError('');
    const { error: updateErr } = await supabase
      .from('jobs')
      .update({
        claimed_by: selectedId,
        claimed_at: new Date().toISOString(),
        status: job.status === 'new' ? 'assigned' : job.status,
      })
      .eq('id', job.id);
    setSaving(false);
    if (updateErr) {
      // Most likely cause of a failure here, if it ever happens: a
      // dispatcher tried to reassign a job that already has an assignee
      // and got blocked by jobs_before_update_assignment_lock -- the UI
      // shouldn't normally let that happen (canChangeAssignee above), but
      // surface the real server message rather than fail silently in
      // case of a race (e.g. owner reassigns the same moment a dispatcher
      // tries).
      setError(updateErr.message);
      return;
    }
    setPicking(false);
    onChanged();
  };

  if (picking) {
    return (
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          style={{ backgroundColor: colors.panelAlt, color: colors.text, border: `1px solid ${colors.borderLight}` }}
          className="text-base rounded-md px-3 py-2.5 min-w-[180px]"
        >
          <option value="">Select a plumber…</option>
          {plumbers.map((p) => (
            <option key={p.id} value={p.id}>{p.full_name || p.email}</option>
          ))}
        </select>
        <button
          onClick={submit}
          disabled={saving}
          style={{ backgroundColor: colors.goldBright, color: colors.bg }}
          className="text-sm font-semibold px-4 py-2.5 rounded-md"
        >
          {saving ? 'Assigning…' : 'Confirm'}
        </button>
        <button
          onClick={() => setPicking(false)}
          style={{ color: colors.muted }}
          className="text-sm px-2 py-2.5"
        >
          Cancel
        </button>
        { error && <p style={{ color: colors.danger }} className="text-xs w-full mt-1">{error}</p> }
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 mt-2 flex-wrap">
      {isAssigned ? (
        <>
          <AssigneeBadge name={assigneeName} />
          {canChangeAssignee && (
            <button
              onClick={startPicking}
              style={{ color: colors.gold }}
              className="text-sm underline underline-offset-2 py-1"
            >
              {role === 'owner' ? 'Reassign' : 'Change'}
            </button>
          )}
        </>
      ) : (
        <button
          onClick={startPicking}
          style={{ backgroundColor: colors.goldBright, color: colors.bg }}
          className="text-sm font-semibold px-4 py-2.5 rounded-md"
        >
          Assign to plumber…
        </button>
      )}
    </div>
  );
}

// Exported so JobsQueue can show the same badge in the collapsed card
// view too (that's the "plumber's name still shows up badged to the job"
// requirement) without duplicating the styling.
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
