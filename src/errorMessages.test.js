import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { logSafeError } from './errorMessages.js';
import { mockSupabase, resetSupabaseMock } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

beforeEach(() => {
  resetSupabaseMock();
});

describe('logSafeError', () => {
  it('logs the real error to the console and returns the fallback message', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rawErr = { message: 'relation "jobs" violates row-level security policy' };

    const result = logSafeError('Could not load jobs:', rawErr, 'Could not load jobs. Please try again.');

    // Synchronous, unchanged contract -- every call site depends on this
    // returning immediately, not a Promise.
    expect(result).toBe('Could not load jobs. Please try again.');
    expect(consoleSpy).toHaveBeenCalledWith('Could not load jobs:', rawErr);
    consoleSpy.mockRestore();
  });

  it('never includes any part of the raw error in its return value', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rawErr = new Error('SECRET_INTERNAL_DETAIL_12345');

    const result = logSafeError('context', rawErr, 'Safe fallback message.');

    expect(result).not.toContain('SECRET_INTERNAL_DETAIL_12345');
    consoleSpy.mockRestore();
  });

  it('also writes the real error to the durable error_log table via log_app_error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rawErr = new Error('relation "jobs" violates row-level security policy');

    logSafeError('Could not load jobs:', rawErr, 'Could not load jobs. Please try again.');

    await waitFor(() => {
      expect(mockSupabase.rpc).toHaveBeenCalledWith('log_app_error', expect.objectContaining({
        p_severity: 'error',
        p_source: 'client:ui',
        p_message: 'Could not load jobs. Please try again.',
        p_detail: expect.stringContaining('relation "jobs" violates row-level security policy'),
      }));
    });
    consoleSpy.mockRestore();
  });

  it('a logging failure never surfaces to the caller -- the fallback is still returned synchronously', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSupabase.rpc.mockImplementation(() => { throw new Error('network down'); });

    expect(() => logSafeError('ctx', new Error('x'), 'Safe message.')).not.toThrow();
    consoleSpy.mockRestore();
  });
});
