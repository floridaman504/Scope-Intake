// Integration tests: Login + AuthProvider + ProtectedRoute wired together
// exactly as main.jsx wires them, exercised through real user interaction
// (typing, clicking) with only the Supabase client mocked. These are
// broader/slower than the unit suite on purpose -- see
// docs/audits/2026-08-06-login-test-suite.md for why they're split into a
// separate `npm run test:integration` script and a separate CI job.
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render } from '@testing-library/react';
import Login from '../../Login.jsx';
import ProtectedRoute from '../../ProtectedRoute.jsx';
import { AuthProvider } from '../../AuthContext.jsx';
import {
  mockSupabase,
  resetSupabaseMock,
  setTableResponse,
  setRpcResponse,
} from '../mocks/supabaseMock.js';

vi.mock('../../supabaseClient.js', async () => {
  const { mockSupabase } = await import('../mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

beforeEach(() => {
  resetSupabaseMock();
});

function App({ initialEntries }) {
  return (
    <MemoryRouter initialEntries={initialEntries} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute allowedRoles={['owner', 'dispatcher']}>
                <div>DASHBOARD_PAGE</div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/sessions"
            element={
              <ProtectedRoute allowedRoles={['owner', 'dispatcher', 'plumber']}>
                <div>SESSIONS_PAGE</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

async function renderApp(initialEntries = ['/login']) {
  const result = render(<App initialEntries={initialEntries} />);
  await waitFor(() => {});
  return result;
}

async function login(user, { email = 'owner@scope.test', password = 'testpw1' } = {}) {
  const emailInput = document.querySelector('input[type="email"]');
  const passwordInput = document.querySelector('input[type="password"]');
  await user.type(emailInput, email);
  await user.type(passwordInput, password);
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('Integration: unauthenticated access to a protected route', () => {
  it('redirects straight to /login when hitting /dashboard with no session', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    await renderApp(['/dashboard']);
    expect(await screen.findByText(/dispatch login/i)).toBeInTheDocument();
  });
});

describe('Integration: full login -> /dashboard redirect', () => {
  it('owner logs in successfully and lands on the dashboard behind ProtectedRoute', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    mockSupabase.auth.signInWithPassword.mockImplementation(async () => {
      // Simulate Supabase's real behavior: a successful sign-in fires
      // onAuthStateChange('SIGNED_IN', ...) with the new session, which is
      // what actually flips ProtectedRoute's `session` from null.
      const authStateCb = mockSupabase.auth.onAuthStateChange.mock.calls[0][0];
      const session = { access_token: 'tok', user: { id: 'owner-1' } };
      await authStateCb('SIGNED_IN', session);
      return { data: { user: session.user }, error: null };
    });
    setTableResponse('employees', { data: { role: 'owner', full_name: 'Dante', email: 'owner@scope.test' }, error: null });

    await renderApp(['/login']);
    await login(user, { email: 'owner@scope.test', password: 'testpw1' });

    await waitFor(() => expect(screen.getByText('DASHBOARD_PAGE')).toBeInTheDocument());
  });

  it('a wrong password leaves the user on /login, never reaching the dashboard', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { message: 'Invalid login credentials' },
    });

    await renderApp(['/login']);
    await login(user, { email: 'owner@scope.test', password: 'wrong' });

    expect(await screen.findByText('Incorrect email or password.')).toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD_PAGE')).not.toBeInTheDocument();
  });
});

describe('Integration: role-based access', () => {
  async function loginAs(role) {
    const user = userEvent.setup();
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    mockSupabase.auth.signInWithPassword.mockImplementation(async () => {
      const authStateCb = mockSupabase.auth.onAuthStateChange.mock.calls[0][0];
      const session = { access_token: 'tok', user: { id: `${role}-1` } };
      await authStateCb('SIGNED_IN', session);
      return { data: { user: session.user }, error: null };
    });
    setTableResponse('employees', { data: { role, full_name: 'Test User', email: `${role}@scope.test` }, error: null });

    await renderApp(['/login']);
    await login(user, { email: `${role}@scope.test`, password: 'testpw1' });
  }

  it('owner can reach /dashboard', async () => {
    await loginAs('owner');
    await waitFor(() => expect(screen.getByText('DASHBOARD_PAGE')).toBeInTheDocument());
  });

  it('dispatcher can reach /dashboard', async () => {
    await loginAs('dispatcher');
    await waitFor(() => expect(screen.getByText('DASHBOARD_PAGE')).toBeInTheDocument());
  });

  it('plumber cannot reach /dashboard (owner/dispatcher only) and sees the access-denied message', async () => {
    await loginAs('plumber');
    await waitFor(() => expect(screen.getByText(/don't have access/i)).toBeInTheDocument());
    expect(screen.queryByText('DASHBOARD_PAGE')).not.toBeInTheDocument();
  });

  it('plumber CAN reach /sessions (owner/dispatcher/plumber all allowed)', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    mockSupabase.auth.signInWithPassword.mockImplementation(async () => {
      const authStateCb = mockSupabase.auth.onAuthStateChange.mock.calls[0][0];
      const session = { access_token: 'tok', user: { id: 'plumber-1' } };
      await authStateCb('SIGNED_IN', session);
      return { data: { user: session.user }, error: null };
    });
    setTableResponse('employees', { data: { role: 'plumber', full_name: 'Test Plumber', email: 'plumber@scope.test' }, error: null });

    const user = userEvent.setup();
    await renderApp(['/login']);
    // Restore-snapshot to /sessions so login lands there instead of the
    // default /dashboard -- exercises the same restore-target mechanism
    // used for expired-session bounces, this time for a role-appropriate page.
    window.sessionStorage.setItem(
      'scope_session_restore_snapshot',
      JSON.stringify({ path: '/sessions', savedAt: Date.now(), reason: 'unauthenticated_direct_access', formData: null })
    );
    await login(user, { email: 'plumber@scope.test', password: 'testpw1' });

    await waitFor(() => expect(screen.getByText('SESSIONS_PAGE')).toBeInTheDocument());
  });
});
