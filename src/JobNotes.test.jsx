// Unit tests for JobNotes: plumber write access (new as of 2026-08-13),
// the realtime postgres_changes subscription that keeps the thread in
// sync across roles/tabs without a manual refresh, and the feature-detected
// speech-to-text mic button. No AuthContext/AuthProvider involved --
// JobNotes takes `employee` directly as a prop.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JobNotes from './JobNotes.jsx';
import { mockSupabase, resetSupabaseMock, setTableResponse } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

const PLUMBER = { id: 'emp-plumber', company_id: 'co-1', role: 'plumber', full_name: 'Pat Plumber' };
const EMPLOYEES_BY_ID = { [PLUMBER.id]: PLUMBER };

beforeEach(() => {
  resetSupabaseMock();
  setTableResponse('job_notes', { data: [], error: null });
});

afterEach(() => {
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
});

describe('JobNotes', () => {
  it('lets a plumber post a note (previously impossible -- job_notes was owner/dispatcher-only)', async () => {
    const user = userEvent.setup();
    render(<JobNotes jobId="job-1" employee={PLUMBER} employeesById={EMPLOYEES_BY_ID} />);

    const textarea = await screen.findByPlaceholderText(/add a note for the team/i);
    await user.type(textarea, 'Replaced the trap, done for today.');
    await user.click(screen.getByRole('button', { name: /post note/i }));

    // Every `.from('job_notes')` call gets its own fresh chain object (the
    // mock's select-on-mount, the insert, and the post-insert reload are
    // three separate chains) -- rather than guess which positional index
    // is "the insert one" (racy: the reload may have already fired by the
    // time this runs), find whichever job_notes chain actually had
    // .insert() called on it.
    const findInsertedChain = () =>
      mockSupabase.from.mock.calls
        .map((call, i) => (call[0] === 'job_notes' ? mockSupabase.from.mock.results[i].value : null))
        .filter(Boolean)
        .find((c) => c.insert.mock.calls.length > 0);

    await waitFor(() => expect(findInsertedChain()).toBeTruthy());
    expect(findInsertedChain().insert).toHaveBeenCalledWith({
      job_id: 'job-1',
      company_id: PLUMBER.company_id,
      author_employee_id: PLUMBER.id,
      body: 'Replaced the trap, done for today.',
    });
  });

  it('subscribes to postgres_changes on job_notes filtered to this job, and reloads on an incoming event', async () => {
    render(<JobNotes jobId="job-42" employee={PLUMBER} employeesById={EMPLOYEES_BY_ID} />);

    await waitFor(() => expect(mockSupabase.channel).toHaveBeenCalledWith('job-notes-job-42'));
    const channelObj = mockSupabase.channel.mock.results[0].value;
    expect(channelObj.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({ event: 'INSERT', table: 'job_notes', filter: 'job_id=eq.job-42' }),
      expect.any(Function)
    );

    // Simulate a note landing from another tab/role via realtime -- the
    // registered callback should trigger a reload (a second select call).
    const initialFromCallCount = mockSupabase.from.mock.calls.filter(([t]) => t === 'job_notes').length;
    const [, , onInsert] = channelObj.on.mock.calls[0];
    onInsert();

    await waitFor(() => {
      const newCount = mockSupabase.from.mock.calls.filter(([t]) => t === 'job_notes').length;
      expect(newCount).toBeGreaterThan(initialFromCallCount);
    });
  });

  it('unsubscribes the realtime channel on unmount', async () => {
    const { unmount } = render(<JobNotes jobId="job-1" employee={PLUMBER} employeesById={EMPLOYEES_BY_ID} />);
    await waitFor(() => expect(mockSupabase.channel).toHaveBeenCalled());
    unmount();
    expect(mockSupabase.removeChannel).toHaveBeenCalled();
  });

  it('shows the dictate mic button when the browser supports SpeechRecognition', async () => {
    window.SpeechRecognition = function () {
      return { start: vi.fn(), stop: vi.fn() };
    };
    render(<JobNotes jobId="job-1" employee={PLUMBER} employeesById={EMPLOYEES_BY_ID} />);
    expect(await screen.findByRole('button', { name: /dictate note/i })).toBeInTheDocument();
  });

  it('does not render the mic button when SpeechRecognition is unsupported (e.g. iOS Safari) -- native keyboard mic still works', async () => {
    render(<JobNotes jobId="job-1" employee={PLUMBER} employeesById={EMPLOYEES_BY_ID} />);
    await screen.findByPlaceholderText(/add a note for the team/i);
    expect(screen.queryByRole('button', { name: /dictate note/i })).not.toBeInTheDocument();
  });

  it('shows an error and does not clear the draft if posting fails', async () => {
    setTableResponse('job_notes', { data: null, error: { message: 'RLS violation' } });
    const user = userEvent.setup();
    render(<JobNotes jobId="job-1" employee={PLUMBER} employeesById={EMPLOYEES_BY_ID} />);

    const textarea = await screen.findByPlaceholderText(/add a note for the team/i);
    await user.type(textarea, 'Trying to post');
    await user.click(screen.getByRole('button', { name: /post note/i }));

    expect(await screen.findByText(/could not post note/i)).toBeInTheDocument();
    expect(textarea).toHaveValue('Trying to post');
  });
});
