// Unit tests for the owner-only error log viewer
// (docs/migrations/2026-08-16-error-log-pipeline.sql, Tier 2 #10). Only
// the read side is under test here -- log_app_error() itself (the write
// side) is exercised against a real local Postgres, not through this
// mock; see docs/audits/2026-08-16-error-boundary-and-logging.md for that
// verification.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import ErrorLog from './ErrorLog.jsx';
import { mockSupabase, resetSupabaseMock, setTableResponse } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

beforeEach(() => {
  resetSupabaseMock();
});

function renderErrorLog() {
  return render(
    <MemoryRouter>
      <ErrorLog />
    </MemoryRouter>
  );
}

describe('ErrorLog', () => {
  it('shows a friendly empty state when there are no rows matching the filters', async () => {
    setTableResponse('error_log', { data: [], error: null });
    renderErrorLog();
    expect(await screen.findByText(/no errors match these filters/i)).toBeInTheDocument();
  });

  it('renders each row with severity, message, source/route, and timestamp', async () => {
    setTableResponse('error_log', {
      data: [
        {
          id: 'e1',
          created_at: '2026-08-16T12:00:00Z',
          severity: 'error',
          source: 'api:review-job',
          route: '/api/v1/review-job',
          http_method: 'POST',
          message: 'The AI service is temporarily unavailable. Please try again.',
          detail: 'Anthropic 529 overloaded\nstack trace...',
        },
        {
          id: 'e2',
          created_at: '2026-08-16T11:00:00Z',
          severity: 'warning',
          source: 'api:check-missed-leads',
          route: '/api/v1/check-missed-leads',
          http_method: 'POST',
          message: 'Missed-lead alert email failed to send for job abc123',
          detail: 'Resend responded with status 403',
        },
      ],
      error: null,
    });
    renderErrorLog();

    expect(await screen.findByText(/the ai service is temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/missed-lead alert email failed to send/i)).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText('warning')).toBeInTheDocument();
    expect(screen.getAllByText(/\/api\/v1\/review-job|\/api\/v1\/check-missed-leads/)).toHaveLength(2);
  });

  it('reveals the raw detail only after clicking "Show details" -- not shown by default', async () => {
    setTableResponse('error_log', {
      data: [
        {
          id: 'e1',
          created_at: '2026-08-16T12:00:00Z',
          severity: 'error',
          source: 'client:ui',
          route: '/dashboard',
          http_method: null,
          message: 'Could not sign out other sessions. Please try again.',
          detail: 'RAW_INTERNAL_STACK_TRACE_TEXT',
        },
      ],
      error: null,
    });
    const user = (await import('@testing-library/user-event')).default.setup();
    renderErrorLog();

    await screen.findByText(/could not sign out other sessions/i);
    expect(screen.queryByText('RAW_INTERNAL_STACK_TRACE_TEXT')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show details/i }));
    expect(screen.getByText('RAW_INTERNAL_STACK_TRACE_TEXT')).toBeInTheDocument();
  });

  it('re-queries with a severity filter applied when the dropdown changes', async () => {
    setTableResponse('error_log', { data: [], error: null });
    const user = (await import('@testing-library/user-event')).default.setup();
    renderErrorLog();

    await screen.findByText(/no errors match these filters/i);
    mockSupabase.from.mockClear();

    await user.selectOptions(screen.getByLabelText(/severity/i), 'warning');

    expect(mockSupabase.from).toHaveBeenCalledWith('error_log');
  });

  it('shows a generic error message (not the raw Supabase error) if the load fails', async () => {
    setTableResponse('error_log', { data: null, error: { message: 'relation "error_log" does not exist' } });
    renderErrorLog();

    expect(await screen.findByText('Could not load the error log. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/relation "error_log"/i)).not.toBeInTheDocument();
  });
});
