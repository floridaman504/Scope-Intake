// Unit tests for the top-level render-error boundary (src/main.jsx wraps
// the entire app in this, above the router -- see that file). New this
// session (Tier 2 #10, "Error Handling Rebuild") along with the durable
// error_log write in componentDidCatch.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ErrorBoundary from './ErrorBoundary.jsx';
import { mockSupabase, resetSupabaseMock } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

beforeEach(() => {
  resetSupabaseMock();
});

function Bomb() {
  throw new Error('SECRET_RENDER_FAILURE_DETAIL');
}

describe('ErrorBoundary', () => {
  it('renders its children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('shows the friendly recovery screen -- never the raw error -- when a child throws', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something Went Wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload page/i })).toBeInTheDocument();
    expect(screen.queryByText(/SECRET_RENDER_FAILURE_DETAIL/)).not.toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it('writes the real error to the durable error_log table', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    await waitFor(() => {
      expect(mockSupabase.rpc).toHaveBeenCalledWith('log_app_error', expect.objectContaining({
        p_severity: 'error',
        p_source: 'client:ErrorBoundary',
        p_message: 'Something Went Wrong',
        p_detail: expect.stringContaining('SECRET_RENDER_FAILURE_DETAIL'),
      }));
    });
    consoleSpy.mockRestore();
  });
});
