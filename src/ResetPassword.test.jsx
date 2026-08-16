// Unit tests for the password-reset landing page. Supabase's client parses
// the recovery link into a session automatically (detectSessionInUrl) --
// simulated here via mockSupabase.auth.getSession(), the same way the rest
// of the suite simulates an authenticated session.
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ResetPassword from './ResetPassword.jsx';
import { renderWithProviders, Route } from './test/utils.jsx';
import { mockSupabase, resetSupabaseMock } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

beforeEach(() => {
  resetSupabaseMock();
});

async function renderResetPassword({ hasSession = true } = {}) {
  if (hasSession) {
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'u1' }, access_token: 'recovery-token' } },
    });
  }
  return renderWithProviders(
    [
      <Route key="reset" path="/reset-password" element={<ResetPassword />} />,
      <Route key="login" path="/login" element={<div>LOGIN_STUB</div>} />,
    ],
    { initialEntries: ['/reset-password'] }
  );
}

function getPasswordInputs() {
  return document.querySelectorAll('input[type="password"], input[type="text"]');
}

describe('ResetPassword', () => {
  it('shows "Link Expired" with no active recovery session', async () => {
    await renderResetPassword({ hasSession: false });
    expect(await screen.findByText(/link expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request a new link/i })).toHaveAttribute('href', '/forgot-password');
  });

  it('shows the new-password form when a valid recovery session exists', async () => {
    await renderResetPassword();
    expect(await screen.findByText(/set a new password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update password/i })).toBeInTheDocument();
  });

  it('rejects mismatched passwords without calling updateUser', async () => {
    const user = userEvent.setup();
    await renderResetPassword();
    await screen.findByText(/set a new password/i);

    const inputs = document.querySelectorAll('input');
    await user.type(inputs[0], 'newpw123');
    await user.type(inputs[1], 'differentpassword2');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
    expect(mockSupabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it('updates the password, signs out everywhere, and redirects to /login on success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null });
    await renderResetPassword();
    await screen.findByText(/set a new password/i);

    const inputs = document.querySelectorAll('input');
    await user.type(inputs[0], 'newpw123');
    await user.type(inputs[1], 'newpw123');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    await waitFor(() => expect(mockSupabase.auth.updateUser).toHaveBeenCalledWith({ password: 'newpw123' }));
    // changePasswordAndSignOutEverywhere logs the reset to the audit trail
    // (docs/migrations/2026-08-16-audit-trail.sql) and revokes every other
    // session too.
    expect(mockSupabase.rpc).toHaveBeenCalledWith('log_password_reset', {});
    expect(mockSupabase.rpc).toHaveBeenCalledWith('sign_out_everywhere', {});
    expect(await screen.findByText(/password updated/i)).toBeInTheDocument();

    vi.advanceTimersByTime(3000);
    await waitFor(() => expect(screen.getByText('LOGIN_STUB')).toBeInTheDocument());
    vi.useRealTimers();
  });

  it('shows an error and stays on the form if updateUser fails', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.updateUser.mockResolvedValue({ data: {}, error: { message: 'Password too weak' } });
    await renderResetPassword();
    await screen.findByText(/set a new password/i);

    const inputs = document.querySelectorAll('input');
    await user.type(inputs[0], 'newpw123');
    await user.type(inputs[1], 'newpw123');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText('Password too weak')).toBeInTheDocument();
    expect(screen.queryByText(/password updated/i)).not.toBeInTheDocument();
  });
});
