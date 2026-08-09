// Unit tests for the "forgot password" request form: submit handling,
// the redirectTo target, and the always-the-same success message (no
// account-enumeration leak). Network is fully mocked, nothing here talks
// to Supabase.
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ForgotPassword from './ForgotPassword.jsx';
import { renderWithProviders, Route } from './test/utils.jsx';
import { mockSupabase, resetSupabaseMock } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

beforeEach(() => {
  resetSupabaseMock();
});

async function renderForgotPassword() {
  return renderWithProviders(
    [<Route key="forgot" path="/forgot-password" element={<ForgotPassword />} />],
    { initialEntries: ['/forgot-password'] }
  );
}

describe('ForgotPassword', () => {
  it('renders the email field and submit button', async () => {
    await renderForgotPassword();
    expect(document.querySelector('input[type="email"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
  });

  it('calls resetPasswordForEmail with the entered email and a same-origin redirectTo', async () => {
    const user = userEvent.setup();
    await renderForgotPassword();

    await user.type(document.querySelector('input[type="email"]'), 'dispatcher@scope.test');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => expect(mockSupabase.auth.resetPasswordForEmail).toHaveBeenCalled());
    const [email, options] = mockSupabase.auth.resetPasswordForEmail.mock.calls[0];
    expect(email).toBe('dispatcher@scope.test');
    expect(options.redirectTo).toMatch(/\/reset-password$/);
  });

  it('shows the same generic success message whether or not the account exists', async () => {
    const user = userEvent.setup();
    await renderForgotPassword();

    await user.type(document.querySelector('input[type="email"]'), 'nobody-at-all@scope.test');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText(/if an account exists for that email/i)).toBeInTheDocument();
  });

  it('shows an error if the request itself fails (network/API error, not "no such account")', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.resetPasswordForEmail.mockResolvedValue({
      data: {},
      error: { message: 'rate limited' },
    });
    await renderForgotPassword();

    await user.type(document.querySelector('input[type="email"]'), 'dispatcher@scope.test');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('has a link back to /login', async () => {
    await renderForgotPassword();
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute('href', '/login');
  });
});
