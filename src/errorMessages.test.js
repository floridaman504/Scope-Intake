import { describe, it, expect, vi } from 'vitest';
import { logSafeError } from './errorMessages.js';

describe('logSafeError', () => {
  it('logs the real error to the console and returns the fallback message', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rawErr = { message: 'relation "jobs" violates row-level security policy' };

    const result = logSafeError('Could not load jobs:', rawErr, 'Could not load jobs. Please try again.');

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
});
