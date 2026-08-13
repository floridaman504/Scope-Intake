import React, { useEffect, useRef, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { colors } from './theme.js';

// Append-only notes thread for a job.
//
// 2026-08-13 update: job_notes RLS is no longer owner/dispatcher only --
// an assigned plumber can now read+write too, scoped to jobs they're
// assigned to (job_notes_select_assigned_plumber / job_notes_insert_
// assigned_plumber, see 2026-08-13-job-notes-plumber-access.sql).
// JobsQueue now mounts this for owner/dispatcher/plumber alike (plumbers
// only ever see their own assigned jobs there in the first place, so
// there's no new exposure). This closes the exact gap Dante flagged --
// "plumber notes live on the jobs is instantly transmitted and displayed
// to the owner and dispatcher eliminating dropped info" -- via two pieces:
//   1. Plumbers can actually write here now (previously impossible).
//   2. A postgres_changes subscription on job_notes (now in the
//      supabase_realtime publication -- see 2026-08-13-realtime-
//      publication-job-notes.sql) means a note posted by anyone shows up
//      for everyone else who has this job open, with no manual refresh.
//      Realtime still respects RLS per-subscriber, so this can't leak a
//      note to someone whose own policies wouldn't already let them see it.
export default function JobNotes({ jobId, employee, employeesById }) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [dictating, setDictating] = useState(false);
  const recognitionRef = useRef(null);

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

    // Live sync: any insert on job_notes for this job (from any role, any
    // tab, any device) reloads the thread here. Filtered server-side to
    // this job_id, not the whole table, so this stays cheap even with a
    // lot of jobs open across a company.
    const channel = supabase
      .channel(`job-notes-${jobId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'job_notes', filter: `job_id=eq.${jobId}` },
        () => { load(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Speech-to-text: an explicit, discoverable mic button using the Web
  // Speech API where the browser supports it (Chrome/Edge/most Android
  // browsers). This is IN ADDITION to, not a replacement for, the native
  // mic button every mobile OS keyboard already shows on a plain text
  // field for free -- that keeps working regardless of this button's
  // support. Feature-detected so it silently doesn't render on browsers
  // without it (notably iOS Safari has poor/no support as of this
  // writing) rather than showing a broken control -- the native keyboard
  // mic is still there for those users.
  const SpeechRecognitionCtor =
    typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

  const toggleDictation = () => {
    if (!SpeechRecognitionCtor) return;

    if (dictating) {
      recognitionRef.current?.stop();
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = true;

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) transcript += event.results[i][0].transcript;
      }
      if (transcript.trim()) {
        setDraft((prev) => (prev ? `${prev.trim()} ${transcript.trim()}` : transcript.trim()));
      }
    };
    recognition.onerror = () => { setDictating(false); };
    recognition.onend = () => { setDictating(false); };

    recognitionRef.current = recognition;
    setDictating(true);
    recognition.start();
  };

  useEffect(() => {
    // Stop any in-flight dictation if the note gets posted or the job
    // panel closes/unmounts while the mic is still listening.
    return () => { recognitionRef.current?.stop(); };
  }, []);

  const submit = async () => {
    const body = draft.trim();
    if (!body || !employee) return;
    if (dictating) recognitionRef.current?.stop();
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
        <div className="relative flex-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note for the team…"
            rows={2}
            style={{ backgroundColor: colors.panelAlt, color: colors.text, border: `1px solid ${colors.borderLight}` }}
            className="text-base rounded-md px-3 py-2.5 pr-11 w-full resize-none"
          />
          {SpeechRecognitionCtor && (
            <button
              type="button"
              onClick={toggleDictation}
              aria-label={dictating ? 'Stop dictating' : 'Dictate note'}
              title={dictating ? 'Stop dictating' : 'Dictate note'}
              style={{
                backgroundColor: dictating ? colors.goldBright : 'transparent',
                color: dictating ? colors.bg : colors.faint,
              }}
              className="absolute right-2 top-2 w-7 h-7 rounded-full flex items-center justify-center text-sm"
            >
              🎤
            </button>
          )}
        </div>
        <button
          onClick={submit}
          disabled={posting || !draft.trim()}
          style={{ backgroundColor: colors.goldBright, color: colors.bg, opacity: !draft.trim() ? 0.5 : 1 }}
          className="text-sm font-semibold px-4 py-2.5 rounded-md shrink-0 self-start"
        >
          {posting ? 'Posting…' : 'Post note'}
        </button>
      </div>
      {dictating && (
        <p style={{ color: colors.faint }} className="text-[11px] mt-1">Listening… tap the mic again to stop.</p>
      )}
    </div>
  );
}
