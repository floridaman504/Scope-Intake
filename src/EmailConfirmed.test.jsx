// Unit tests for the signup-confirmation landing page. Dormant in
// production today (Confirm Email is off), but these tests simulate the
// two states that matter once it's turned on: a valid confirmation session
// with no employees row yet (redeem the invite code here), and an
// expired/invalid link (no session at all). Mirrors ResetPassword.test.jsx's
// approach to simulating detectSessionInUrl via mockSupabase.auth.getSession().
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EmailConfirmed from './EmailConfirmed.jsx';
import { renderWithProviders, Route } from './test/utils.jsx';
import { mockSupabase, resetSupabaseMock, setTableResponse } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

beforeEach(() => {
  resetSupabaseMock();
});

async function renderEmailConfirmed({ hasSession = true, hasEmployee = false } = {}) {
  if (hasSession) {
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'u1', email: 'jamie@scope.test' }, access_token: 'confirm-token' } },
    });
  }
  if (hasEmployee) {
    setTableResponse('employees', {
      data: { id: 'emp1', user_id: 'u1', company_id: 'c1', role: 'plumber', full_name: 'Jamie Plumber', email: 'jamie@scope.test', deactivated_at: null },
      error: null,
    });
  }
  return renderWithProviders(
    [
      <Route key="confirmed" path="/email-confirmed" element={<EmailConfirmed />} />,
      <Route key="join" path="/join" element={<div>JOIN_STUB</div>} />,
      <Route key="dashboard" path="/dashboard" element={<div>DASHBOARD_STUB</div>} />,
    ],
    { initialEntries: ['/email-confirmed'] }
  );
}

describe('EmailConfirmed', () => {
  it('shows "Link Expired" with no active confirmation session', async () => {
    await renderEmailConfirmed({ hasSession: false });
    expect(await screen.findByText(/link expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /start over/i })).toHaveAttribute('href', '/join');
  });

  it('shows the finish-joining form when confirmed but not yet an employee', async () => {
    await renderEmailConfirmed();
    expect(await screen.findByText(/email confirmed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join team/i })).toBeInTheDocument();
  });

  it('redeems the invite code using the session email, then redirects to /dashboard', async () => {
    const user = userEvent.setup();
    mockSupabase.rpc.mockResolvedValue({ data: null, error: null });
    await renderEmailConfirmed();
    await screen.findByText(/email confirmed/i);

    const inputs = document.querySelectorAll('input');
    await user.type(inputs[0], 'SCOPE-4X7K');
    await user.type(inputs[1], 'Jamie Plumber');
    await user.click(screen.getByRole('button', { name: /join team/i }));

    expect(mockSupabase.rpc).toHaveBeenCalledWith('redeem_invite_code', {
      invite_code: 'SCOPE-4X7K',
      employee_full_name: 'Jamie Plumber',
      employee_email: 'jamie@scope.test',
    });
    await waitFor(() => expect(screen.getByText('DASHBOARD_STUB')).toBeInTheDocument());
  });

  it('shows an error and does not redirect if the invite code is invalid', async () => {
    const user = userEvent.setup();
    mockSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: 'That invite code is invalid or already used.' },
    });
    await renderEmailConfirmed();
    await screen.findByText(/email confirmed/i);

    const inputs = document.querySelectorAll('input');
    await user.type(inputs[0], 'BOGUS-0000');
    await user.type(inputs[1], 'Jamie Plumber');
    await user.click(screen.getByRole('button', { name: /join team/i }));

    expect(await screen.findByText('That invite code is invalid or already used.')).toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD_STUB')).not.toBeInTheDocument();
  });

  it('redirects straight to /dashboard if an employee record already exists (stale re-click)', async () => {
    await renderEmailConfirmed({ hasEmployee: true });
    await waitFor(() => expect(screen.getByText('DASHBOARD_STUB')).toBeInTheDocument());
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('redeem_invite_code', expect.anything());
  });
});
