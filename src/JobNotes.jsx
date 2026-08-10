import React, { useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { colors } from './theme.js';

// Append-only notes thread for a job. Matches job_notes' RLS exactly:
// owner + dispatcher only (see 2026-08-09-dispatcher-dashboard.sql --
// job_notes_select_company_dispatch / job_notes_insert_company_dispatch),
// no update/delete policy at all. JobsQueue only mounts this for those two
// roles, so there's no "plumber sees an empty/broken notes box" case to
// handle -- it's simply never rendered for them, same as the backend.
export default function JobNotes({ jobId, employee, employeesById }) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const load = async () => {
    setError('');
    const { data, error: loadErr } = await supabase
      .from('job_notes')
      .select('id, body, created_at, author_employee_id')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });
    if (loadErr) {
      setError('Could not load notes: ' + loadErr.message);
    } else {
      setNotes(data || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || !employee) return;
    setPosting(true);
    setError('');
    const { error: insertErr } = await supabase.from('job_notes').insert({
      job_id: jobId,
      company_id: employee.company_id,
      author_employee_id: employee.id,
      body,
    });
    setPosting(false);
    if (insertErr) {
      setError('Could not post note: ' + insertErr.message);
      return;
    }
    setDraft('');
    await load();
  };

  return (
    <div style={{ borderTop: `1px solid ${colors.border}` }} className="mt-3 pt-3">
      <p style={{ color: colors.faint }} className="text-xs font-semibold uppercase tracking-wide mb-2">Notes</p>

      {loading ? (
        <p style={{ color: colors.faint }} className="text-xs">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p style={{ color: colors.faint }} className="text-xs italic">No notes yet.</p>
      ) : (
        <div className="space-y-2 mb-3">
          {notes.map((n) => (
            <div key={n.id} style={{ backgroundColor: colors.panelAlt }} className="rounded-md px-3 py-2">
              <p style={{ color: colors.text }} className="text-sm leading-relaxed whitespace-pre-wrap">{n.body}</p>
              <p style={{ color: colors.faint }} className="text-[11px] mt-1">
                {employeesById[n.author_employee_id]?.full_name || 'Someone'} · {new Date(n.created_at).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}

      {error && <p style={{ color: colors.danger }} className="text-xs mb-2">{error}</p>}

      <div className="flex flex-col sm:flex-row gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note for the team…"
          rows={2}
          style={{ backgroundColor: colors.panelAlt, color: colors.text, border: `1px solid ${colors.borderLight}` }}
          className="text-base rounded-md px-3 py-2.5 flex-1 resize-none"
        />
        <button
          onClick={submit}
          disabled={posting || !draft.trim()}
          style={{ backgroundColor: colors.goldBright, color: colors.bg, opacity: !draft.trim() ? 0.5 : 1 }}
          className="text-sm font-semibold px-4 py-2.5 rounded-md shrink-0 self-start"
        >
          {posting ? 'Posting…' : 'Post note'}
        </button>
      </div>
    </div>
  );
}
