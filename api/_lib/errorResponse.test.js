import { describe, it, expect, vi } from 'vitest';
import { sendSafeError } from './errorResponse.js';

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

describe('sendSafeError', () => {
  it('logs the real error server-side and sends only the safe message in the response body', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();
    const rawErr = { message: 'duplicate key value violates unique constraint "jobs_pkey"' };

    sendSafeError(res, 500, rawErr, 'Something went wrong processing your request. Please try again.');

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong processing your request. Please try again.' });
    expect(JSON.stringify(res.body)).not.toContain('jobs_pkey');
    expect(consoleSpy).toHaveBeenCalledWith('Something went wrong processing your request. Please try again.', rawErr);
    consoleSpy.mockRestore();
  });

  it('uses whatever status code is passed through', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();

    sendSafeError(res, 429, new Error('rate limited internally'), 'Too many requests.');

    expect(res.statusCode).toBe(429);
    consoleSpy.mockRestore();
  });
});
