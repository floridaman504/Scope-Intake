// Unit tests for the login form itself: submit handling, error display,
// loading state, HTML5 field validation, and the post-login redirect
// target (including the restore-snapshot / open-redirect guard). Network
// is fully mocked via src/test/mocks/supabaseMock.js -- nothing here talks
// to Supabase.
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Login from './Login.jsx';
import { renderWithProviders, Route } from './test/utils.jsx';
import { mockSupabase, resetSupabaseMock, setRpcResponse } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

beforeEach(() => {
  resetSupabaseMock();
});

async function renderLogin({ initialEntries = ['/login'] } = {}) {
  return renderWithProviders(
    [
      <Route key="login" path="/login" element={<Login />} />,
      <Route key="dashboard" path="/dashboard" element={<div>DASHBOARD_STUB</div>} />,
      <Route key="jobs" path="/jobs/42" element={<div>JOB_42_STUB</div>} />,
    ],
    { initialEntries }
  );
}

function getEmailInput() {
  return document.querySelector('input[type="email"]');
}
function getPasswordInput() {
  return document.querySelector('input[type="password"]');
}

async function fillAndSubmit(user, { email = 'dispatcher@scope.test', password = 'testpw1' } = {}) {
  await user.type(getEmailInput(), email);
  await user.type(getPasswordInput(), password);
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('Login', () => {
  it('renders the email and password fields', async () => {
    await renderLogin();
    expect(getEmailInput()).toBeInTheDocument();
    expect(getPasswordInput()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('successful login calls signInWithPassword and redirects to /dashboard', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    await renderLogin();

    await fillAndSubmit(user, { email: 'dispatcher@scope.test', password: 'testpw1' });

    expect(mockSupabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'dispatcher@scope.test',
      password: 'testpw1',
    });
    await waitFor(() => expect(screen.getByText('DASHBOARD_STUB')).toBeInTheDocument());
  });

  it('failed login with wrong password shows an error and does not redirect', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { message: 'Invalid login credentials' },
    });
    await renderLogin();

    await fillAndSubmit(user, { email: 'dispatcher@scope.test', password: 'wrongpw1' });

    expect(await screen.findByText('Incorrect email or password.')).toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD_STUB')).not.toBeInTheDocument();
    // Still on the login form -- password field is still there with the
    // value the user typed (the app doesn't clear it on failure).
    expect(getPasswordInput()).toHaveValue('wrongpw1');
  });

  it('does not leak the real error message from Supabase to the UI', async () => {
    const user = userEvent.setup();
    // Real Supabase errors can be more specific than we want to show
    // (rate limiting details, etc) -- the app intentionally normalizes to
    // one generic message rather than passing error.message through.
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { message: 'AuthApiError: some internal detail' },
    });
    await renderLogin();

    await fillAndSubmit(user);

    expect(await screen.findByText('Incorrect email or password.')).toBeInTheDocument();
    expect(screen.queryByText(/AuthApiError/)).not.toBeInTheDocument();
  });

  it('shows a loading state while the request is in flight and disables the button', async () => {
    const user = userEvent.setup();
    let resolveSignIn;
    mockSupabase.auth.signInWithPassword.mockReturnValue(
      new Promise((resolve) => { resolveSignIn = resolve; })
    );
    await renderLogin();

    const emailInput = getEmailInput();
    const passwordInput = getPasswordInput();
    await user.type(emailInput, 'dispatcher@scope.test');
    await user.type(passwordInput, 'testpw1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('button', { name: /signing in/i })).toBeDisabled();

    resolveSignIn({ data: { user: { id: 'u1' } }, error: null });
    await waitFor(() => expect(screen.getByText('DASHBOARD_STUB')).toBeInTheDocument());
  });

  it('does not call signInWithPassword when required fields are empty', async () => {
    const user = userEvent.setup();
    await renderLogin();
    // A real click on the submit button (unlike a synthetic `submit` event)
    // runs the browser's native constraint validation first -- required
    // empty fields should block the submit handler from ever running.
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(mockSupabase.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(getEmailInput().checkValidity()).toBe(false);
  });

  it('rejects a malformed email via the input type="email" constraint', async () => {
    const user = userEvent.setup();
    await renderLogin();
    const emailInput = getEmailInput();
    await user.type(emailInput, 'not-an-email');
    await user.type(getPasswordInput(), 'testpw1');

    expect(emailInput.checkValidity()).toBe(false);

    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(mockSupabase.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('shows the session-expired banner when redirected with ?expired=1', async () => {
    await renderLogin({ initialEntries: ['/login?expired=1&reason=inactivity_timeout'] });
    expect(screen.getByText(/signed out after a period of inactivity/i)).toBeInTheDocument();
  });

  it('shows a generic expired message for an unrecognized reason code', async () => {
    await renderLogin({ initialEntries: ['/login?expired=1&reason=something_unrecognized'] });
    expect(screen.getByText('You were signed out.')).toBeInTheDocument();
  });

  it('redirects back to a saved restore-snapshot path instead of /dashboard after login', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    window.sessionStorage.setItem(
      'scope_session_restore_snapshot',
      JSON.stringify({ path: '/jobs/42', savedAt: Date.now(), reason: 'inactivity_timeout', formData: null })
    );
    await renderLogin();

    await fillAndSubmit(user);

    await waitFor(() => expect(screen.getByText('JOB_42_STUB')).toBeInTheDocument());
  });

  it('falls back to /dashboard if the restore-snapshot path looks like an open redirect', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    window.sessionStorage.setItem(
      'scope_session_restore_snapshot',
      JSON.stringify({ path: '//evil.example.com', savedAt: Date.now(), reason: 'x', formData: null })
    );
    await renderLogin();

    await fillAndSubmit(user);

    await waitFor(() => expect(screen.getByText('DASHBOARD_STUB')).toBeInTheDocument());
  });

  it('ignores an expired restore snapshot (older than the max age) and lands on /dashboard', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    window.sessionStorage.setItem(
      'scope_session_restore_snapshot',
      JSON.stringify({ path: '/jobs/42', savedAt: Date.now() - 60 * 60 * 1000, reason: 'x', formData: null })
    );
    await renderLogin();

    await fillAndSubmit(user);

    await waitFor(() => expect(screen.getByText('DASHBOARD_STUB')).toBeInTheDocument());
  });

  // --- Tier 1.5: account lockout after repeated failed attempts ----------
  describe('account lockout', () => {
    it('shows a "Forgot password?" link that points to /forgot-password', async () => {
      await renderLogin();
      const link = screen.getByRole('link', { name: /forgot password/i });
      expect(link).toHaveAttribute('href', '/forgot-password');
    });

    it('checks check_login_allowed before attempting sign-in', async () => {
      const user = userEvent.setup();
      mockSupabase.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
      await renderLogin();

      await fillAndSubmit(user, { email: 'dispatcher@scope.test', password: 'testpw1' });

      expect(mockSupabase.rpc).toHaveBeenCalledWith('check_login_allowed', { p_email: 'dispatcher@scope.test' });
    });

    it('blocks the sign-in attempt and shows a countdown when the account is locked', async () => {
      const user = userEvent.setup();
      const lockedUntil = new Date(Date.now() + 7 * 60 * 1000).toISOString(); // 7 min out
      setRpcResponse('check_login_allowed', { data: [{ allowed: false, locked_until: lockedUntil }], error: null });
      await renderLogin();

      await fillAndSubmit(user, { email: 'locked@scope.test', password: 'whatever1' });

      expect(await screen.findByText(/too many failed attempts/i)).toBeInTheDocument();
      expect(screen.getByText(/try again in 7 minutes/i)).toBeInTheDocument();
      // The real credential check never happens once locked out.
      expect(mockSupabase.auth.signInWithPassword).not.toHaveBeenCalled();
    });

    it('records a failed attempt via record_failed_login when the password is wrong', async () => {
      const user = userEvent.setup();
      setRpcResponse('check_login_allowed', { data: [{ allowed: true, locked_until: null }], error: null });
      mockSupabase.auth.signInWithPassword.mockResolvedValue({
        data: {},
        error: { message: 'Invalid login credentials' },
      });
      await renderLogin();

      await fillAndSubmit(user, { email: 'dispatcher@scope.test', password: 'wrongpw1' });

      await screen.findByText('Incorrect email or password.');
      expect(mockSupabase.rpc).toHaveBeenCalledWith('record_failed_login', { p_email: 'dispatcher@scope.test' });
    });

    it('clears the failed-attempt count via clear_login_attempts on a successful sign-in', async () => {
      const user = userEvent.setup();
      setRpcResponse('check_login_allowed', { data: [{ allowed: true, locked_until: null }], error: null });
      mockSupabase.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
      await renderLogin();

      await fillAndSubmit(user, { email: 'dispatcher@scope.test', password: 'testpw1' });

      await waitFor(() => expect(screen.getByText('DASHBOARD_STUB')).toBeInTheDocument());
      expect(mockSupabase.rpc).toHaveBeenCalledWith('clear_login_attempts', { p_email: 'dispatcher@scope.test' });
    });

    it('fails open (still attempts sign-in) if the lockout check RPC itself errors', async () => {
      const user = userEvent.setup();
      setRpcResponse('check_login_allowed', { data: null, error: { message: 'function not found' } });
      mockSupabase.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
      await renderLogin();

      await fillAndSubmit(user, { email: 'dispatcher@scope.test', password: 'testpw1' });

      // An outage in the lockout system must never be the reason a real
      // login fails -- the sign-in attempt still goes through.
      expect(mockSupabase.auth.signInWithPassword).toHaveBeenCalled();
      await waitFor(() => expect(screen.getByText('DASHBOARD_STUB')).toBeInTheDocument());
    });
  });
});
