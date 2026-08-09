// Pure unit tests for ProtectedRoute's own logic: loading state, redirect
// when unauthenticated, role-gating, and the restore-snapshot write it does
// on an unauthenticated direct hit. useAuth() is mocked directly (not via
// a real AuthProvider) so this file tests ProtectedRoute in isolation --
// the full AuthProvider + ProtectedRoute + Login wiring is covered by the
// integration suite in src/test/integration/.
import React from 'react';
import { screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render } from '@testing-library/react';
import ProtectedRoute from './ProtectedRoute.jsx';
import { RESTORE_SNAPSHOT_KEY } from './sessionConfig.js';

const useAuthMock = vi.fn();
vi.mock('./AuthContext.jsx', () => ({
  useAuth: () => useAuthMock(),
}));

beforeEach(() => {
  useAuthMock.mockReset();
  window.sessionStorage.clear();
});

function renderProtected({ allowedRoles, initialEntries = ['/dashboard'] } = {}) {
  return render(
    <MemoryRouter initialEntries={initialEntries} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/login" element={<div>LOGIN_STUB</div>} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute allowedRoles={allowedRoles}>
              <div>PROTECTED_CONTENT</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('ProtectedRoute', () => {
  it('shows a loading state while auth is still resolving', () => {
    useAuthMock.mockReturnValue({ session: null, employee: null, loading: true });
    renderProtected();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText('PROTECTED_CONTENT')).not.toBeInTheDocument();
  });

  it('redirects to /login when there is no session', () => {
    useAuthMock.mockReturnValue({ session: null, employee: null, loading: false });
    renderProtected();
    expect(screen.getByText('LOGIN_STUB')).toBeInTheDocument();
    expect(screen.queryByText('PROTECTED_CONTENT')).not.toBeInTheDocument();
  });

  it('saves a restore snapshot for the direct-access URL when redirecting unauthenticated', () => {
    useAuthMock.mockReturnValue({ session: null, employee: null, loading: false });
    renderProtected({ initialEntries: ['/dashboard?x=1'] });

    const raw = window.sessionStorage.getItem(RESTORE_SNAPSHOT_KEY);
    expect(raw).not.toBeNull();
    const snapshot = JSON.parse(raw);
    expect(snapshot.path).toBe('/dashboard?x=1');
    expect(snapshot.reason).toBe('unauthenticated_direct_access');
  });

  it('does not overwrite an existing restore snapshot', () => {
    window.sessionStorage.setItem(RESTORE_SNAPSHOT_KEY, JSON.stringify({ path: '/keep-me', savedAt: 1, reason: 'x', formData: null }));
    useAuthMock.mockReturnValue({ session: null, employee: null, loading: false });
    renderProtected();

    const snapshot = JSON.parse(window.sessionStorage.getItem(RESTORE_SNAPSHOT_KEY));
    expect(snapshot.path).toBe('/keep-me');
  });

  it('renders children when authenticated with no role restriction', () => {
    useAuthMock.mockReturnValue({ session: { user: { id: 'u1' } }, employee: { role: 'plumber' }, loading: false });
    renderProtected();
    expect(screen.getByText('PROTECTED_CONTENT')).toBeInTheDocument();
  });

  it('allows an owner into a route restricted to owner/dispatcher', () => {
    useAuthMock.mockReturnValue({ session: { user: { id: 'u1' } }, employee: { role: 'owner' }, loading: false });
    renderProtected({ allowedRoles: ['owner', 'dispatcher'] });
    expect(screen.getByText('PROTECTED_CONTENT')).toBeInTheDocument();
  });

  it('allows a dispatcher into a route restricted to owner/dispatcher', () => {
    useAuthMock.mockReturnValue({ session: { user: { id: 'u1' } }, employee: { role: 'dispatcher' }, loading: false });
    renderProtected({ allowedRoles: ['owner', 'dispatcher'] });
    expect(screen.getByText('PROTECTED_CONTENT')).toBeInTheDocument();
  });

  it('blocks a plumber from a route restricted to owner/dispatcher', () => {
    useAuthMock.mockReturnValue({ session: { user: { id: 'u1' } }, employee: { role: 'plumber' }, loading: false });
    renderProtected({ allowedRoles: ['owner', 'dispatcher'] });
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByText('PROTECTED_CONTENT')).not.toBeInTheDocument();
  });

  it('blocks access when the employee row has not loaded yet even with a session', () => {
    useAuthMock.mockReturnValue({ session: { user: { id: 'u1' } }, employee: null, loading: false });
    renderProtected({ allowedRoles: ['owner', 'dispatcher'] });
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
  });
});
