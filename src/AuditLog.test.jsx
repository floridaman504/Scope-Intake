// Unit tests for the owner-only audit log viewer
// (docs/migrations/2026-08-16-audit-trail.sql, Tier 2 #9.5). Only the read
// side is under test here -- there's no client code that ever writes an
// audit_log row directly (see AuthContext.test.jsx's log_password_reset
// coverage for the one client-initiated write, and
// docs/audits/2026-08-16-audit-trail.md for how the trigger-written rows
// were verified against a real local Postgres).
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import AuditLog from './AuditLog.jsx';
import { mockSupabase, resetSupabaseMock, setTableResponse } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

beforeEach(() => {
  resetSupabaseMock();
});

function renderAuditLog() {
  return render(
    <MemoryRouter>
      <AuditLog />
    </MemoryRouter>
  );
}

describe('AuditLog', () => {
  it('shows a friendly empty state when there are no rows yet', async () => {
    setTableResponse('audit_log', { data: [], error: null });
    renderAuditLog();
    expect(await screen.findByText(/no sensitive actions recorded yet/i)).toBeInTheDocument();
  });

  it('renders each row with a human-readable action label, actor, target, and timestamp', async () => {
    setTableResponse('audit_log', {
      data: [
        {
          id: 'a1',
          action: 'employee_deactivated',
          actor_label: 'Ollie Owner',
          target_table: 'employees',
          target_label: 'Jamie Plumber',
          details: { deactivated_at: '2026-08-16T12:00:00Z' },
          ip_address: '203.0.113.5',
          created_at: '2026-08-16T12:00:00Z',
        },
        {
          id: 'a2',
          action: 'job_deleted',
          actor_label: 'Ollie Owner',
          target_table: 'jobs',
          target_label: 'Sarah Customer',
          details: { status: 'new', customer_name: 'Sarah Customer' },
          ip_address: null,
          created_at: '2026-08-16T11:00:00Z',
        },
      ],
      error: null,
    });
    renderAuditLog();

    expect(await screen.findByText('Employee deactivated')).toBeInTheDocument();
    expect(screen.getByText('Job deleted')).toBeInTheDocument();
    expect(screen.getAllByText('Ollie Owner').length).toBe(2);
    // "Jamie Plumber"/"Sarah Customer" each show up in more than one place
    // (the actor/target line, and -- for the job row -- the detail line
    // too), so just confirm they're present at all rather than asserting
    // on a single exact match.
    expect(screen.getAllByText(/Jamie Plumber/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Sarah Customer/).length).toBeGreaterThan(0);
    expect(screen.getByText(/IP: 203\.0\.113\.5/)).toBeInTheDocument();
  });

  it('falls back to the raw action string for an action with no known label, so nothing silently disappears', async () => {
    setTableResponse('audit_log', {
      data: [{
        id: 'a3',
        action: 'some_future_action',
        actor_label: 'Ollie Owner',
        target_table: 'employees',
        target_label: 'Someone',
        details: null,
        ip_address: null,
        created_at: '2026-08-16T12:00:00Z',
      }],
      error: null,
    });
    renderAuditLog();
    expect(await screen.findByText('some_future_action')).toBeInTheDocument();
  });

  it('shows a safe generic error (not the raw Supabase message) if the audit log itself fails to load', async () => {
    setTableResponse('audit_log', { data: null, error: { message: 'permission denied for table audit_log' } });
    renderAuditLog();
    expect(await screen.findByText(/could not load the audit log/i)).toBeInTheDocument();
  });

  it('queries audit_log ordered newest-first, capped at 200 rows', async () => {
    setTableResponse('audit_log', { data: [], error: null });
    renderAuditLog();
    await waitFor(() => expect(mockSupabase.from).toHaveBeenCalledWith('audit_log'));

    const chain = mockSupabase.from.mock.results[
      mockSupabase.from.mock.calls.findIndex((c) => c[0] === 'audit_log')
    ].value;
    expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(chain.limit).toHaveBeenCalledWith(200);
  });
});
