// Unit tests for the Join/signup flow: signUp + redeem_invite_code, and
// every branch documented in Join.jsx's own comments (email confirmation
// required, invalid/already-used invite code, generic failure). Network is
// fully mocked -- no real signups, no real invite codes touch Supabase.
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Join from './Join.jsx';
import { renderWithProviders, Route } from './test/utils.jsx';
import { mockSupabase, resetSupabaseMock } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

beforeEach(() => {
  resetSupabaseMock();
});

async function renderJoin() {
  return renderWithProviders([
    <Route key="join" path="/join" element={<Join />} />,
    <Route key="dashboard" path="/dashboard" element={<div>DASHBOARD_STUB</div>} />,
  ], { initialEntries: ['/join'] });
}

function getField(placeholderOrLabel) {
  // Same accessibility gap as Login.jsx -- labels aren't programmatically
  // associated with inputs, so query by position/type instead of role/label.
  return placeholderOrLabel;
}

async function fillJoinForm(user, { code = 'SCOPE-4X7K', fullName = 'Jamie Plumber', email = 'jamie@scope.test', password = 'hunter22' } = {}) {
  const inputs = document.querySelectorAll('input');
  const [codeInput, nameInput, emailInput, passwordInput] = inputs;
  await user.type(codeInput, code);
  await user.type(nameInput, fullName);
  await user.type(emailInput, email);
  await user.type(passwordInput, password);
  await user.click(screen.getByRole('button', { name: /join team/i }));
}

describe('Join (signup + invite code redemption)', () => {
  it('renders the invite code, name, email, and password fields', async () => {
    await renderJoin();
    expect(document.querySelectorAll('input').length).toBe(4);
    expect(screen.getByRole('button', { name: /join team/i })).toBeInTheDocument();
  });

  it('successful signup + invite code redemption redirects to /dashboard', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.signUp.mockResolvedValue({
      data: { session: { access_token: 'tok' }, user: { id: 'u1' } },
      error: null,
    });
    mockSupabase.rpc.mockResolvedValue({ data: null, error: null });
    await renderJoin();

    await fillJoinForm(user);

    expect(mockSupabase.auth.signUp).toHaveBeenCalledWith({
      email: 'jamie@scope.test',
      password: 'hunter22',
    });
    expect(mockSupabase.rpc).toHaveBeenCalledWith('redeem_invite_code', {
      invite_code: 'SCOPE-4X7K',
      employee_full_name: 'Jamie Plumber',
      employee_email: 'jamie@scope.test',
    });
    await waitFor(() => expect(screen.getByText('DASHBOARD_STUB')).toBeInTheDocument());
  });

  it('trims whitespace from the invite code before redeeming it', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.signUp.mockResolvedValue({
      data: { session: { access_token: 'tok' }, user: { id: 'u1' } },
      error: null,
    });
    await renderJoin();
    await fillJoinForm(user, { code: '  SCOPE-4X7K  ' });

    expect(mockSupabase.rpc).toHaveBeenCalledWith('redeem_invite_code', expect.objectContaining({
      invite_code: 'SCOPE-4X7K',
    }));
  });

  it('shows a safe generic error (not the raw Supabase message) and does not redeem an invite code if signUp itself fails', async () => {
    // Regression guard for the error-handling audit (docs/audits/2026-08-16-error-handling.md):
    // the raw error.message must never reach the UI, even though it's shown here.
    const user = userEvent.setup();
    mockSupabase.auth.signUp.mockResolvedValue({
      data: {},
      error: { message: 'User already registered' },
    });
    await renderJoin();

    await fillJoinForm(user);

    expect(await screen.findByText('Could not create your account. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText('User already registered')).not.toBeInTheDocument();
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
    expect(screen.queryByText('DASHBOARD_STUB')).not.toBeInTheDocument();
  });

  it('prompts for email confirmation when signUp succeeds without a session, and does not redeem the code yet', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.signUp.mockResolvedValue({
      data: { session: null, user: { id: 'u1' } },
      error: null,
    });
    await renderJoin();

    await fillJoinForm(user);

    expect(await screen.findByText(/check your email to confirm it/i)).toBeInTheDocument();
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
    expect(screen.queryByText('DASHBOARD_STUB')).not.toBeInTheDocument();
  });

  it('shows an error for an invalid invite code and does not redirect', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.signUp.mockResolvedValue({
      data: { session: { access_token: 'tok' }, user: { id: 'u1' } },
      error: null,
    });
    mockSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: 'That invite code is invalid or already used.' },
    });
    await renderJoin();

    await fillJoinForm(user, { code: 'BOGUS-0000' });

    expect(await screen.findByText('That invite code is invalid or already used.')).toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD_STUB')).not.toBeInTheDocument();
  });

  it('shows the generic invite-code error (not the raw RPC message) for an already-used code, and does not redirect', async () => {
    // Regression guard for the error-handling audit: every redeem_invite_code
    // failure now shows the same safe generic message regardless of the raw
    // Postgres/RPC wording -- see errorMessages.js.
    const user = userEvent.setup();
    mockSupabase.auth.signUp.mockResolvedValue({
      data: { session: { access_token: 'tok' }, user: { id: 'u1' } },
      error: null,
    });
    mockSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: 'This invite code has already been used.' },
    });
    await renderJoin();

    await fillJoinForm(user, { code: 'SCOPE-USED' });

    expect(await screen.findByText('That invite code is invalid or already used.')).toBeInTheDocument();
    expect(screen.queryByText('This invite code has already been used.')).not.toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD_STUB')).not.toBeInTheDocument();
  });

  it('falls back to a generic invite-code error if the RPC error has no message', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.signUp.mockResolvedValue({
      data: { session: { access_token: 'tok' }, user: { id: 'u1' } },
      error: null,
    });
    mockSupabase.rpc.mockResolvedValue({ data: null, error: {} });
    await renderJoin();

    await fillJoinForm(user);

    expect(await screen.findByText('That invite code is invalid or already used.')).toBeInTheDocument();
  });

  it('shows a generic error if signUp throws unexpectedly', async () => {
    const user = userEvent.setup();
    mockSupabase.auth.signUp.mockRejectedValue(new Error('network exploded'));
    await renderJoin();

    await fillJoinForm(user);

    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
  });

  it('does not submit when required fields are empty', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await user.click(screen.getByRole('button', { name: /join team/i }));
    expect(mockSupabase.auth.signUp).not.toHaveBeenCalled();
  });

  it('declares a 6-character minimum on the password field', async () => {
    // Note: jsdom does not implement live minlength constraint validation
    // (checkValidity() ignores it, unlike a real browser), so this checks
    // the constraint is declared in the markup rather than exercising
    // native form-blocking behavior, which can't be observed in this
    // environment. The `required`/`type="email"` constraints tested
    // elsewhere in this file ARE enforced by jsdom and are exercised for
    // real.
    await renderJoin();
    const inputs = document.querySelectorAll('input');
    const passwordInput = inputs[3];
    expect(passwordInput).toHaveAttribute('minlength', '6');
    expect(passwordInput).toHaveAttribute('required');
  });

  it('rejects a malformed email', async () => {
    const user = userEvent.setup();
    await renderJoin();
    const inputs = document.querySelectorAll('input');
    await user.type(inputs[0], 'SCOPE-4X7K');
    await user.type(inputs[1], 'Jamie Plumber');
    await user.type(inputs[2], 'not-an-email');
    await user.type(inputs[3], 'hunter22');

    expect(inputs[2].checkValidity()).toBe(false);
    await user.click(screen.getByRole('button', { name: /join team/i }));
    expect(mockSupabase.auth.signUp).not.toHaveBeenCalled();
  });
});
