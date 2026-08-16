// Unit tests for the owner-only Team page: the existing deactivate/
// reactivate flow, plus the new in-place role-edit control. useAuth() is
// mocked directly (not via a real AuthProvider), same pattern as
// ProtectedRoute.test.jsx, so this file tests EmployeeManagement in
// isolation from the rest of the auth machinery.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EmployeeManagement from './EmployeeManagement.jsx';
import { mockSupabase, resetSupabaseMock, setTableResponse } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

const useAuthMock = vi.fn();
vi.mock('./AuthContext.jsx', () => ({
  useAuth: () => useAuthMock(),
}));

const OWNER = { id: 'me-1', full_name: 'Ollie Owner', role: 'owner' };
const JAMIE = { id: 'emp-2', full_name: 'Jamie Plumber', email: 'jamie@scope.test', role: 'plumber', deactivated_at: null };

beforeEach(() => {
  resetSupabaseMock();
  useAuthMock.mockReset().mockReturnValue({ employee: OWNER });
  window.confirm = vi.fn(() => true);
});

function renderPage() {
  return render(
    <MemoryRouter>
      <EmployeeManagement />
    </MemoryRouter>
  );
}

describe('EmployeeManagement role editing', () => {
  it('shows a role dropdown (not the owner\'s own row) defaulted to the employee\'s current role', async () => {
    setTableResponse('employees', { data: [JAMIE], error: null });
    renderPage();

    const select = await screen.findByRole('combobox', { name: /change role for jamie plumber/i });
    expect(select).toHaveValue('plumber');
  });

  it('does not show a role dropdown for the signed-in owner\'s own row', async () => {
    setTableResponse('employees', { data: [{ ...OWNER, email: 'owner@scope.test', deactivated_at: null }], error: null });
    renderPage();

    await screen.findByText(/owner@scope.test/);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('confirms, then updates the role and reloads on confirm', async () => {
    const user = userEvent.setup();
    setTableResponse('employees', { data: [JAMIE], error: null });
    renderPage();

    const select = await screen.findByRole('combobox', { name: /change role for jamie plumber/i });
    await user.selectOptions(select, 'dispatcher');

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Plumber to Dispatcher'));

    const findUpdatedChain = () =>
      mockSupabase.from.mock.calls
        .map((call, i) => (call[0] === 'employees' ? mockSupabase.from.mock.results[i].value : null))
        .filter(Boolean)
        .find((c) => c.update.mock.calls.length > 0);

    await waitFor(() => expect(findUpdatedChain()).toBeTruthy());
    expect(findUpdatedChain().update).toHaveBeenCalledWith({ role: 'dispatcher' });
    expect(findUpdatedChain().eq).toHaveBeenCalledWith('id', 'emp-2');
  });

  it('does not call update if the confirm dialog is declined', async () => {
    window.confirm = vi.fn(() => false);
    const user = userEvent.setup();
    setTableResponse('employees', { data: [JAMIE], error: null });
    renderPage();

    const select = await screen.findByRole('combobox', { name: /change role for jamie plumber/i });
    await user.selectOptions(select, 'owner');

    const updatedAnyEmployeesChain = mockSupabase.from.mock.calls
      .map((call, i) => (call[0] === 'employees' ? mockSupabase.from.mock.results[i].value : null))
      .filter(Boolean)
      .some((c) => c.update.mock.calls.length > 0);
    expect(updatedAnyEmployeesChain).toBe(false);
  });

  it('shows a safe generic error (not the raw Supabase message) if the role update fails', async () => {
    const user = userEvent.setup();
    setTableResponse('employees', { data: [JAMIE], error: null });
    renderPage();

    const select = await screen.findByRole('combobox', { name: /change role for jamie plumber/i });

    // Second call to .from('employees') (the update) should reject; keep
    // the load-time response resolving fine by leaving setTableResponse as
    // configured and overriding only the update chain's own resolution via
    // a spy-once implementation is more than this mock supports directly,
    // so instead simulate a failed update by having the *next* load also
    // return the same data but assert on the error path via a thrown
    // rejection surfaced through the mock's error field.
    setTableResponse('employees', { data: null, error: { message: 'permission denied for table employees' } });
    await user.selectOptions(select, 'dispatcher');

    expect(await screen.findByText('Could not update employee role. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/permission denied/i)).not.toBeInTheDocument();
  });
});

describe('EmployeeManagement deactivate/reactivate (existing behavior, regression check)', () => {
  it('still shows Deactivate for an active employee and Reactivate for a deactivated one', async () => {
    setTableResponse('employees', {
      data: [
        JAMIE,
        { id: 'emp-3', full_name: 'Dana Deactivated', email: 'dana@scope.test', role: 'dispatcher', deactivated_at: '2026-08-01T00:00:00Z' },
      ],
      error: null,
    });
    renderPage();

    expect(await screen.findByRole('button', { name: /^deactivate$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reactivate$/i })).toBeInTheDocument();
  });
});
