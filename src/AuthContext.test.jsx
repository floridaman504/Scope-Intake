// Unit tests for AuthContext's own logic: employee loading, session
// registration (register_session / touch_session), sign-out (revoke_session),
// and the "fails open" behavior when the Tier 1.3 RPCs aren't available yet
// (they aren't -- supabase_session_hardening.sql hasn't been applied to
// production). A tiny consumer component exposes the hook's return value so
// tests can assert on it without going through Login/ProtectedRoute (that
// combination is covered by the integration suite).
import React from 'react';
import { screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { renderWithProviders, Route } from './test/utils.jsx';
import {
  mockSupabase,
  resetSupabaseMock,
  setTableResponse,
  setRpcResponse,
  fireAuthStateChange,
} from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

function Consumer() {
  const auth = useAuth();
  return (
    <div>
      <div data-testid="session">{auth.session ? 'has-session' : 'no-session'}</div>
      <div data-testid="employee-role">{auth.employee?.role ?? 'none'}</div>
      <div data-testid="loading">{String(auth.loading)}</div>
      <div data-testid="session-id">{auth.sessionId ?? 'none'}</div>
      <button onClick={() => auth.signOut()}>sign-out</button>
      <button onClick={() => auth.signOutEverywhere()}>sign-out-everywhere</button>
    </div>
  );
}

async function renderConsumer({ initialEntries = ['/dashboard'] } = {}) {
  return renderWithProviders([
    <Route key="dash" path="/dashboard" element={<Consumer />} />,
    <Route key="login" path="/login" element={<div>LOGIN_STUB</div>} />,
  ], { initialEntries });
}

const AUTH_SESSION = { access_token: 'tok', user: { id: 'user-1' } };

beforeEach(() => {
  resetSupabaseMock();
});

describe('AuthContext', () => {
  it('starts with loading=true and settles to no session when getSession resolves null', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    await renderConsumer();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('session')).toHaveTextContent('no-session');
    expect(screen.getByTestId('employee-role')).toHaveTextContent('none');
  });

  it('loads the employee row (role/full_name/email) when a session exists', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: AUTH_SESSION } });
    setTableResponse('employees', { data: { role: 'owner', full_name: 'Dante', email: 'dante@scope.test' }, error: null });
    await renderConsumer();

    await waitFor(() => expect(screen.getByTestId('employee-role')).toHaveTextContent('owner'));
    expect(mockSupabase.from).toHaveBeenCalledWith('employees');
  });

  it('treats a deactivated employee the same as no employee row', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: AUTH_SESSION } });
    setTableResponse('employees', {
      data: { role: 'plumber', full_name: 'Jamie', email: 'jamie@scope.test', deactivated_at: '2026-08-12T00:00:00Z' },
      error: null,
    });
    await renderConsumer();

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    // The row loaded successfully -- this isn't a query error -- but a
    // deactivated employee should be treated as logged-out for app
    // purposes (ProtectedRoute's allowedRoles check bounces a null
    // employee the same way it would an unrecognized account).
    expect(screen.getByTestId('employee-role')).toHaveTextContent('none');
  });

  it('sets employee to null if the employees lookup errors', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: AUTH_SESSION } });
    setTableResponse('employees', { data: null, error: { message: 'no rows' } });
    await renderConsumer();

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('employee-role')).toHaveTextContent('none');
  });

  it('registers a new session via register_session on initial load with a session', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: AUTH_SESSION } });
    setTableResponse('employees', { data: { role: 'dispatcher', full_name: 'D', email: 'd@scope.test' }, error: null });
    setRpcResponse('register_session', { data: 'new-session-id', error: null });
    await renderConsumer();

    await waitFor(() => expect(screen.getByTestId('session-id')).toHaveTextContent('new-session-id'));
    expect(mockSupabase.rpc).toHaveBeenCalledWith('register_session', expect.objectContaining({
      p_device_label: expect.any(String),
      p_user_agent: expect.any(String),
    }));
    expect(window.sessionStorage.getItem('scope_session_id')).toBe('new-session-id');
  });

  it('reuses an existing sessionStorage session id via touch_session instead of registering a new one', async () => {
    window.sessionStorage.setItem('scope_session_id', 'existing-session-id');
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: AUTH_SESSION } });
    setTableResponse('employees', { data: { role: 'dispatcher', full_name: 'D', email: 'd@scope.test' }, error: null });
    setRpcResponse('touch_session', { data: [{ valid: true, revoked: false }], error: null });
    await renderConsumer();

    await waitFor(() => expect(screen.getByTestId('session-id')).toHaveTextContent('existing-session-id'));
    expect(mockSupabase.rpc).toHaveBeenCalledWith('touch_session', { p_session_id: 'existing-session-id' });
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('register_session', expect.anything());
  });

  it('registers a fresh session if the stored session id is no longer valid', async () => {
    window.sessionStorage.setItem('scope_session_id', 'stale-session-id');
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: AUTH_SESSION } });
    setTableResponse('employees', { data: { role: 'dispatcher', full_name: 'D', email: 'd@scope.test' }, error: null });
    setRpcResponse('touch_session', { data: [{ valid: false, revoked: true }], error: null });
    setRpcResponse('register_session', { data: 'brand-new-id', error: null });
    await renderConsumer();

    await waitFor(() => expect(screen.getByTestId('session-id')).toHaveTextContent('brand-new-id'));
  });

  it('degrades gracefully (fails open) when register_session RPC is unavailable -- e.g. hardening SQL not applied yet', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: AUTH_SESSION } });
    setTableResponse('employees', { data: { role: 'owner', full_name: 'D', email: 'd@scope.test' }, error: null });
    setRpcResponse('register_session', { data: null, error: { message: 'function register_session does not exist' } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await renderConsumer();

    // Normal auth still works -- session/employee load fine -- the app
    // just has no session row/sessionId, exactly the "inert until the
    // migration runs" behavior documented in AuthContext.jsx.
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('session')).toHaveTextContent('has-session');
    expect(screen.getByTestId('session-id')).toHaveTextContent('none');
    warnSpy.mockRestore();
  });

  it('signOut calls revoke_session then supabase.auth.signOut and clears local state', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    window.sessionStorage.setItem('scope_session_id', 'sess-1');
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: AUTH_SESSION } });
    setTableResponse('employees', { data: { role: 'owner', full_name: 'D', email: 'd@scope.test' }, error: null });
    setRpcResponse('touch_session', { data: [{ valid: true, revoked: false }], error: null });
    await renderConsumer();
    await waitFor(() => expect(screen.getByTestId('session-id')).toHaveTextContent('sess-1'));

    await user.click(screen.getByText('sign-out'));

    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('no-session'));
    expect(mockSupabase.rpc).toHaveBeenCalledWith('revoke_session', { p_session_id: 'sess-1', p_reason: 'user_sign_out' });
    expect(mockSupabase.auth.signOut).toHaveBeenCalled();
    expect(window.sessionStorage.getItem('scope_session_id')).toBeNull();
  });

  it('signOutEverywhere calls the sign_out_everywhere RPC and returns its data', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: AUTH_SESSION } });
    setTableResponse('employees', { data: { role: 'owner', full_name: 'D', email: 'd@scope.test' }, error: null });
    setRpcResponse('sign_out_everywhere', { data: { revoked_count: 2 }, error: null });
    await renderConsumer();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(screen.getByText('sign-out-everywhere'));

    await waitFor(() => expect(mockSupabase.rpc).toHaveBeenCalledWith('sign_out_everywhere', {}));
  });

  it('reacts to an externally-signed-out auth state change (e.g. refresh token rejected) by clearing session and saving a restore snapshot', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: AUTH_SESSION } });
    setTableResponse('employees', { data: { role: 'owner', full_name: 'D', email: 'd@scope.test' }, error: null });
    await renderConsumer();
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('has-session'));

    act(() => {
      fireAuthStateChange('SIGNED_OUT', null);
    });

    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('no-session'));
    const raw = window.sessionStorage.getItem('scope_session_restore_snapshot');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw).reason).toBe('auth_state_signed_out_externally');
  });
});
