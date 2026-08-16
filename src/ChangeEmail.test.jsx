// Unit tests for the self-service "change my email" form. useAuth() is
// mocked directly (not via a real AuthProvider), same isolation pattern as
// EmployeeManagement.test.jsx -- this component only reads employee.email
// from context, it doesn't need the rest of the auth machinery.
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ChangeEmail from './ChangeEmail.jsx';
import { mockSupabase, resetSupabaseMock } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

const useAuthMock = vi.fn();
vi.mock('./AuthContext.jsx', () => ({
  useAuth: () => useAuthMock(),
}));

beforeEach(() => {
  resetSupabaseMock();
  useAuthMock.mockReset().mockReturnValue({
    employee: { id: 'emp-1', email: 'ollie@acme.test', full_name: 'Ollie Owner' },
  });
});

function renderPage() {
  return render(
    <MemoryRouter>
      <ChangeEmail />
    </MemoryRouter>
  );
}

describe('ChangeEmail', () => {
  it('shows the current email', () => {
    renderPage();
    expect(screen.getByText(/current email: ollie@acme\.test/i)).toBeInTheDocument();
  });

  it('requests the change with the correct redirect and shows the sent confirmation', async () => {
    const user = userEvent.setup();
    renderPage();

    const input = document.querySelector('input[type="email"]');
    await user.type(input, 'ollie-new@acme.test');
    await user.click(screen.getByRole('button', { name: /send confirmation link/i }));

    expect(mockSupabase.auth.updateUser).toHaveBeenCalledWith(
      { email: 'ollie-new@acme.test' },
      { emailRedirectTo: expect.stringContaining('/email-changed') }
    );
    expect(await screen.findByText(/confirm the change using the link/i)).toBeInTheDocument();
  });

  it('rejects submitting the same email without calling updateUser', async () => {
    const user = userEvent.setup();
    renderPage();

    const input = document.querySelector('input[type="email"]');
    await user.type(input, 'ollie@acme.test');
    await user.click(screen.getByRole('button', { name: /send confirmation link/i }));

    expect(await screen.findByText(/that.s already your current email/i)).toBeInTheDocument();
    expect(mockSupabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it('shows a safe generic error (not the raw Supabase message) if the request fails', async () => {
    mockSupabase.auth.updateUser.mockResolvedValue({ data: {}, error: { message: 'email rate limit exceeded' } });
    const user = userEvent.setup();
    renderPage();

    const input = document.querySelector('input[type="email"]');
    await user.type(input, 'ollie-new@acme.test');
    await user.click(screen.getByRole('button', { name: /send confirmation link/i }));

    expect(await screen.findByText('Could not update your email right now. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/rate limit/i)).not.toBeInTheDocument();
  });
});
