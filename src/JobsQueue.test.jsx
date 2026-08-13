// Unit tests for the 2026-08-13 jobs-view redesign: agenda grouping,
// and the role-gated schedule/duration controls. useAuth() is mocked
// directly (same pattern as ProtectedRoute.test.jsx) rather than going
// through a real AuthProvider -- JobsQueue never reads AuthContext's own
// employee-lookup query, so this avoids the shared supabaseMock's
// last-call-wins-per-table limitation colliding between AuthContext's
// single-employee lookup and JobsQueue's own company-wide employee list
// query (both hit the same 'employees' table name).
import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import JobsQueue, { scheduleGroupFor } from './JobsQueue.jsx';
import { mockSupabase, resetSupabaseMock, setTableResponse, setRpcResponse } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

const useAuthMock = vi.fn();
vi.mock('./AuthContext.jsx', () => ({
  useAuth: () => useAuthMock(),
}));

const OWNER = { id: 'emp-owner', company_id: 'co-1', role: 'owner', full_name: 'Owen Owner' };
const DISPATCHER = { id: 'emp-dispatch', company_id: 'co-1', role: 'dispatcher', full_name: 'Dana Dispatch' };
const PLUMBER = { id: 'emp-plumber', company_id: 'co-1', role: 'plumber', full_name: 'Pat Plumber' };

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

const JOB_UNSCHEDULED = {
  id: 'job-unscheduled', created_at: new Date().toISOString(), customer_name: 'Alice',
  customer_phone: null, customer_email: null, ai_job_type: 'Leak repair', ai_urgency: 'high',
  ai_summary: null, ai_watch_out: null, status: 'new', media: [],
  scheduled_start: null, scheduled_end: null, estimated_duration_minutes: null,
};

const JOB_SCHEDULED = {
  id: 'job-scheduled', created_at: new Date().toISOString(), customer_name: 'Bob',
  customer_phone: null, customer_email: null, ai_job_type: 'Drain clog', ai_urgency: 'medium',
  ai_summary: null, ai_watch_out: null, status: 'assigned', media: [],
  scheduled_start: isoDaysFromNow(1), scheduled_end: null, estimated_duration_minutes: 45,
};

function setupJobsQueueData() {
  setTableResponse('jobs', { data: [JOB_UNSCHEDULED, JOB_SCHEDULED], error: null });
  setTableResponse('employees', { data: [OWNER, DISPATCHER, PLUMBER], error: null });
  setTableResponse('job_assignees', {
    data: [{ job_id: 'job-scheduled', employee_id: PLUMBER.id, assigned_at: new Date().toISOString() }],
    error: null,
  });
}

function renderJobsQueue() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<JobsQueue />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  resetSupabaseMock();
  useAuthMock.mockReset();
  setupJobsQueueData();
});

describe('scheduleGroupFor', () => {
  const now = new Date('2026-08-13T12:00:00Z');

  it('groups a job with no scheduled_start as Unscheduled', () => {
    expect(scheduleGroupFor({ scheduled_start: null }, now)).toBe('Unscheduled');
  });

  it('groups a job scheduled later the same day as Today', () => {
    expect(scheduleGroupFor({ scheduled_start: '2026-08-13T20:00:00Z' }, now)).toBe('Today');
  });

  it('groups a job scheduled the next calendar day as Tomorrow', () => {
    expect(scheduleGroupFor({ scheduled_start: '2026-08-14T09:00:00Z' }, now)).toBe('Tomorrow');
  });

  it('groups a job 5 days out as This week', () => {
    expect(scheduleGroupFor({ scheduled_start: '2026-08-18T09:00:00Z' }, now)).toBe('This week');
  });

  it('groups a job more than a week out as Later', () => {
    expect(scheduleGroupFor({ scheduled_start: '2026-09-01T09:00:00Z' }, now)).toBe('Later');
  });

  it('groups a job whose window already passed as Past', () => {
    expect(scheduleGroupFor({ scheduled_start: '2026-08-01T09:00:00Z' }, now)).toBe('Past');
  });
});

describe('JobsQueue role-gated schedule/duration controls', () => {
  it('owner sees both the schedule-window and duration controls, and notes, when expanded', async () => {
    useAuthMock.mockReturnValue({ employee: OWNER });
    const user = userEvent.setup();
    renderJobsQueue();

    const detailsButtons = await screen.findAllByRole('button', { name: /details/i });
    await user.click(detailsButtons[0]);

    expect(await screen.findByText(/scheduled window/i)).toBeInTheDocument();
    expect(screen.getByText(/estimated duration/i)).toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
  });

  it('dispatcher sees the schedule-window control but NOT the duration control', async () => {
    useAuthMock.mockReturnValue({ employee: DISPATCHER });
    const user = userEvent.setup();
    renderJobsQueue();

    const detailsButtons = await screen.findAllByRole('button', { name: /details/i });
    await user.click(detailsButtons[0]);

    expect(await screen.findByText(/scheduled window/i)).toBeInTheDocument();
    expect(screen.queryByText(/estimated duration/i)).not.toBeInTheDocument();
  });

  it('an assigned plumber sees Details, duration control, and notes -- but no status/assignment/schedule controls', async () => {
    useAuthMock.mockReturnValue({ employee: PLUMBER });
    const user = userEvent.setup();
    renderJobsQueue();

    // Plumber only sees their own assigned job (job-scheduled) -- exactly
    // one Details button, not two.
    const detailsButtons = await screen.findAllByRole('button', { name: /details/i });
    expect(detailsButtons).toHaveLength(1);
    await user.click(detailsButtons[0]);

    expect(await screen.findByText(/estimated duration/i)).toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.queryByText(/scheduled window/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Status$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Assignment$/)).not.toBeInTheDocument();
  });

  it('calls set_job_duration with the entered minutes when the owner blurs the duration input', async () => {
    setRpcResponse('set_job_duration', { data: { ...JOB_UNSCHEDULED, estimated_duration_minutes: 30 }, error: null });
    useAuthMock.mockReturnValue({ employee: OWNER });
    const user = userEvent.setup();
    renderJobsQueue();

    const detailsButtons = await screen.findAllByRole('button', { name: /details/i });
    await user.click(detailsButtons[0]);

    const durationInput = await screen.findByPlaceholderText(/e\.g\. 45/i);
    await user.type(durationInput, '30');
    await user.tab();

    await waitFor(() => expect(mockSupabase.rpc).toHaveBeenCalledWith('set_job_duration', {
      p_job_id: expect.any(String),
      p_minutes: 30,
    }));
  });

  it('updates scheduled_start via a plain jobs update when the dispatcher changes the schedule window', async () => {
    useAuthMock.mockReturnValue({ employee: DISPATCHER });
    const user = userEvent.setup();
    const { container } = renderJobsQueue();

    const detailsButtons = await screen.findAllByRole('button', { name: /details/i });
    await user.click(detailsButtons[0]);
    await screen.findByText(/scheduled window/i);

    const datetimeInputs = container.querySelectorAll('input[type="datetime-local"]');
    expect(datetimeInputs.length).toBeGreaterThan(0);
    await user.type(datetimeInputs[0], '2026-09-01T10:00');

    await waitFor(() => expect(mockSupabase.from).toHaveBeenCalledWith('jobs'));
    const jobsChain = mockSupabase.from.mock.results.find((r, i) => mockSupabase.from.mock.calls[i][0] === 'jobs');
    expect(jobsChain).toBeTruthy();
  });
});
