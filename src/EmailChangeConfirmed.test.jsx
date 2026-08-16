// Unit tests for the email-change confirmation landing page. Mirrors
// ResetPassword.test.jsx's pattern: Supabase's client parses the
// confirmation link into a session automatically (detectSessionInUrl),
// simulated here via mockSupabase.auth.getSession().
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EmailChangeConfirmed from './EmailChangeConfirmed.jsx';
import { renderWithProviders, Route } from './test/utils.jsx';
import { mockSupabase, resetSupabaseMock } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

beforeEach(() => {
  resetSupabaseMock();
});

async function renderEmailChangeConfirmed({ hasSession = true } = {}) {
  if (hasSession) {
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'u1' }, access_token: 'email-change-token' } },
    });
  }
  return renderWithProviders(
    [
      <Route key="changed" path="/email-changed" element={<EmailChangeConfirmed />} />,
      <Route key="dash" path="/dashboard" element={<div>DASHBOARD_STUB</div>} />,
    ],
    { initialEntries: ['/email-changed'] }
  );
}

describe('EmailChangeConfirmed', () => {
  it('shows "Link Expired" with no active session', async () => {
    await renderEmailChangeConfirmed({ hasSession: false });
    expect(await screen.findByText(/link expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute('href', '/dashboard');
  });

  it('calls sync_my_email and shows the success message when a valid session exists', async () => {
    await renderEmailChangeConfirmed();
    await waitFor(() => expect(mockSupabase.rpc).toHaveBeenCalledWith('sync_my_email', {}));
    expect(await screen.findByText(/email updated/i)).toBeInTheDocument();
    expect(screen.getByText(/confirmed and up to date/i)).toBeInTheDocument();
  });

  it('still shows a non-blocking success screen if sync_my_email itself errors', async () => {
    mockSupabase.rpc.mockImplementation((fnName) =>
      fnName === 'sync_my_email'
        ? Promise.resolve({ data: null, error: { message: 'permission denied' } })
        : Promise.resolve({ data: null, error: null })
    );
    await renderEmailChangeConfirmed();

    expect(await screen.findByText(/email updated/i)).toBeInTheDocument();
    expect(screen.getByText(/may take a moment to show up everywhere/i)).toBeInTheDocument();
    expect(screen.queryByText(/permission denied/i)).not.toBeInTheDocument();
  });
});
