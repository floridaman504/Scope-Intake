// Integration test for the Tier 1.3 sliding-expiry + warning-modal flow:
// SessionExpiryWarning + AuthContext's countdown timer + forceSignOut's
// redirect-with-restore-snapshot, using fake timers so the test doesn't
// need to wait out a real inactivity window. See
// docs/audits/2026-08-06-session-auth-hardening.md for the real timing
// (WARNING_LEAD_SECONDS=60s before expiry); this test configures a short
// per-role max_lifetime_minutes via the mocked session_policy table so the
// whole flow completes in a couple of simulated minutes instead of hours.
import React from 'react';
import { screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render } from '@testing-library/react';
import Login from '../../Login.jsx';
import ProtectedRoute from '../../ProtectedRoute.jsx';
import SessionExpiryWarning from '../../SessionExpiryWarning.jsx';
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

function App() {
  return (
    // No v7_startTransition future flag here (unlike loginFlow.test.jsx) --
    // wrapping navigation in startTransition reorders this test's two
    // competing navigate() calls (AuthContext's forceSignOut() vs.
    // ProtectedRoute's own <Navigate> on session becoming null) enough that
    // the query-string-carrying navigate can lose the race under fake
    // timers. Real users don't hit this: it only showed up because fake
    // timers collapse timing that's normally spread over real minutes.
    <MemoryRouter initialEntries={['/dashboard']}>
      <AuthProvider>
        <SessionExpiryWarning />
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
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

const SESSION = { access_token: 'tok', user: { id: 'owner-1' } };

beforeEach(() => {
  resetSupabaseMock();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Integration: session sliding-expiry warning + forced sign-out', () => {
  it('shows the "Still there?" warning near expiry, then signs out and redirects to /login with a reason, once idle time runs out', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: SESSION } });
    setTableResponse('employees', { data: { role: 'owner', full_name: 'Dante', email: 'owner@scope.test' }, error: null });
    // 2-minute max lifetime for `owner` -- short enough to simulate with
    // fake timers in milliseconds, long enough to be well above
    // WARNING_LEAD_SECONDS (60s) so the warning and the sign-out are two
    // distinct, separately-observable events rather than firing together.
    setTableResponse('session_policy', { data: [{ role: 'owner', max_lifetime_minutes: 2 }], error: null });
    setRpcResponse('register_session', { data: 'sess-expiry-1', error: null });
    setRpcResponse('touch_session', { data: [{ valid: true, revoked: false }], error: null });

    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<App />);
    await vi.waitFor(() => expect(screen.getByText('DASHBOARD_PAGE')).toBeInTheDocument());

    // No warning yet, well before the lead time.
    expect(screen.queryByText('Still there?')).not.toBeInTheDocument();

    // Advance to inside the 60s warning window (61s of simulated
    // inactivity out of the 120s lifetime).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.getByText('Still there?')).toBeInTheDocument();
    expect(mockSupabase.auth.signOut).not.toHaveBeenCalled();

    // Advance past the full 120s lifetime -- forceSignOut should fire,
    // sign out, and redirect to /login with an inactivity_timeout reason.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    await vi.waitFor(() => expect(mockSupabase.auth.signOut).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.getByText(/signed out after a period of inactivity/i)).toBeInTheDocument());
  }, 20_000);

  it('clicking "Stay signed in" during the warning extends the session and cancels the sign-out', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: SESSION } });
    setTableResponse('employees', { data: { role: 'owner', full_name: 'Dante', email: 'owner@scope.test' }, error: null });
    setTableResponse('session_policy', { data: [{ role: 'owner', max_lifetime_minutes: 2 }], error: null });
    setRpcResponse('register_session', { data: 'sess-expiry-2', error: null });
    setRpcResponse('touch_session', { data: [{ valid: true, revoked: false }], error: null });

    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<App />);
    await vi.waitFor(() => expect(screen.getByText('DASHBOARD_PAGE')).toBeInTheDocument());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.getByText('Still there?')).toBeInTheDocument();

    const user = (await import('@testing-library/user-event')).default.setup({
      advanceTimers: vi.advanceTimersByTime,
    });
    await act(async () => {
      await user.click(screen.getByRole('button', { name: /stay signed in/i }));
    });

    expect(screen.queryByText('Still there?')).not.toBeInTheDocument();

    // Advance another 61s (well past the *original* deadline, but the
    // clock was reset by extendSession) -- should still be signed in and
    // NOT show the warning again yet, since it should be freshly counting
    // from the extend, not the original login.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.getByText('DASHBOARD_PAGE')).toBeInTheDocument();
    expect(mockSupabase.auth.signOut).not.toHaveBeenCalled();
  }, 20_000);
});
