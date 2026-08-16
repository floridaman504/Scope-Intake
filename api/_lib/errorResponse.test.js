import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendSafeError, logAppError } from './errorResponse.js';

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

const ENV = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'anon-key',
};

describe('sendSafeError', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  });

  it('logs the real error server-side and sends only the safe message in the response body', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })));
    const res = makeRes();
    const rawErr = { message: 'duplicate key value violates unique constraint "jobs_pkey"' };

    await sendSafeError(res, 500, rawErr, 'Something went wrong processing your request. Please try again.');

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong processing your request. Please try again.' });
    expect(JSON.stringify(res.body)).not.toContain('jobs_pkey');
    expect(consoleSpy).toHaveBeenCalledWith('Something went wrong processing your request. Please try again.', rawErr);
    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('uses whatever status code is passed through', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })));
    const res = makeRes();

    await sendSafeError(res, 429, new Error('rate limited internally'), 'Too many requests.');

    expect(res.statusCode).toBe(429);
    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('also writes the real error to the durable error_log table via log_app_error (Tier 2 #10)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();
    const rawErr = new Error('duplicate key value violates unique constraint "jobs_pkey"');

    await sendSafeError(res, 500, rawErr, 'Something went wrong.', { source: 'api:review-job', route: '/api/review-job', method: 'POST' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/rest/v1/rpc/log_app_error'),
      expect.objectContaining({ method: 'POST' })
    );
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      p_severity: 'error',
      p_source: 'api:review-job',
      p_route: '/api/review-job',
      p_http_method: 'POST',
      p_message: 'Something went wrong.',
    });
    expect(body.p_detail).toContain('jobs_pkey');
    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('still returns the safe response even if the logging call itself fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));
    const res = makeRes();

    await sendSafeError(res, 500, new Error('x'), 'Safe message.');

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Safe message.' });
    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('still returns the safe response even with no Supabase env vars configured', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.VITE_SUPABASE_ANON_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();

    await sendSafeError(res, 500, new Error('x'), 'Safe message.');

    expect(res.statusCode).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe('logAppError', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  });

  it('defaults an unrecognized/missing severity-adjacent field set without throwing', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(logAppError({ severity: 'warning', source: 'api:check-missed-leads', message: 'a warning' })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
