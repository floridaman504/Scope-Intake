// Tests for the missed-lead escalation cron endpoint (api/check-missed-leads.js).
// Flagged as an untested gap in PR #23 -- vitest.config.js's coverage
// scope is src/-only (see that file's own comment), and no harness for
// api/*.js existed at all before this file. Everything here runs through
// the real exported `handler`, with `fetch` stubbed to a small router so
// no request ever leaves the process -- same no-network-call principle
// ScopeIntake.test.jsx already uses for the browser side.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import handler from './check-missed-leads.js';

const ENV = {
  CRON_SECRET: 'test-secret',
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  RESEND_API_KEY: 'resend-key',
};

function makeReq({ method = 'POST', secret = ENV.CRON_SECRET } = {}) {
  return {
    method,
    headers: secret === undefined ? {} : { 'x-cron-secret': secret },
  };
}

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

const OVERDUE_JOB = {
  id: 'job-1',
  company_id: 'company-1',
  customer_name: 'Jamie Customer',
  customer_phone: '5551234567',
  customer_email: 'jamie@example.com',
  ai_job_type: 'Leaking pipe',
  ai_urgency: 'Medium',
  created_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
};

const OWNER = { email: 'owner@example.com', full_name: 'Owner', role: 'owner' };

// Builds a fetch stub that dispatches on URL shape, matching the real
// sequence handler() drives: GET jobs -> (per job) GET employees -> POST
// Resend -> PATCH jobs. Each stage's response is overridable per test.
function makeFetchRouter({ jobs = [], employees = OWNER ? [OWNER] : [], emailOk = true, emailStatus = 200, patchOk = true, patchStatus = 200 } = {}) {
  return vi.fn((url, opts = {}) => {
    const method = opts.method || 'GET';
    if (typeof url === 'string' && url.includes('/rest/v1/jobs?select=') && method === 'GET') {
      return Promise.resolve({ ok: true, json: async () => jobs });
    }
    if (typeof url === 'string' && url.includes('/rest/v1/employees?')) {
      return Promise.resolve({ ok: true, json: async () => employees });
    }
    if (typeof url === 'string' && url.includes('api.resend.com/emails')) {
      return Promise.resolve({ ok: emailOk, status: emailStatus, json: async () => ({}) });
    }
    if (typeof url === 'string' && url.includes('/rest/v1/jobs?id=eq.') && method === 'PATCH') {
      return Promise.resolve({ ok: patchOk, status: patchStatus, json: async () => ({}) });
    }
    throw new Error(`Unexpected fetch call: ${method} ${url}`);
  });
}

describe('check-missed-leads handler', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  });

  it('rejects methods other than POST/GET', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'DELETE' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects a missing or wrong cron secret', async () => {
    const res = makeRes();
    await handler(makeReq({ secret: 'wrong' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects when CRON_SECRET itself is not configured', async () => {
    delete process.env.CRON_SECRET;
    const res = makeRes();
    await handler(makeReq({ secret: 'anything' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 500 when Supabase server credentials are missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/Supabase/i);
  });

  it('returns 500 when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/RESEND_API_KEY/);
  });

  it('reports zero checked/alerted when there are no overdue jobs', async () => {
    vi.stubGlobal('fetch', makeFetchRouter({ jobs: [] }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ checked: 0, alerted: 0 });
    vi.unstubAllGlobals();
  });

  it('sends the alert and marks the job alerted on the happy path', async () => {
    const fetchMock = makeFetchRouter({ jobs: [OVERDUE_JOB] });
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ checked: 1, alerted: 1, failed: 0, failures: [] });
    // Confirms an email actually went out before the job was marked alerted.
    const resendCall = fetchMock.mock.calls.find(([url]) => String(url).includes('resend.com'));
    expect(resendCall).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('does not mark alerted, and records a failure, when the email send fails', async () => {
    const fetchMock = makeFetchRouter({ jobs: [OVERDUE_JOB], emailOk: false, emailStatus: 403 });
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.body.alerted).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(res.body.failures).toEqual([{ jobId: OVERDUE_JOB.id, status: 403 }]);
    // The regression this guards against: a failed send must NOT reach
    // the mark-as-alerted PATCH at all (job stays eligible for retry).
    const patchCall = fetchMock.mock.calls.find(([url, opts]) => opts?.method === 'PATCH');
    expect(patchCall).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('counts a failed mark-as-alerted PATCH as failed, not alerted (PR #23 fix)', async () => {
    const fetchMock = makeFetchRouter({ jobs: [OVERDUE_JOB], patchOk: false, patchStatus: 500 });
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();
    await handler(makeReq(), res);
    // Before the fix, this asserted alerted: 1 -- exactly the bug: the
    // send succeeded but the row was never actually marked, and the old
    // code reported success anyway.
    expect(res.body.alerted).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(res.body.failures).toEqual([{ jobId: OVERDUE_JOB.id, status: 500, stage: 'mark_alerted' }]);
    vi.unstubAllGlobals();
  });

  it('marks alerted without sending when a company has no owner/dispatcher recipients', async () => {
    const fetchMock = makeFetchRouter({ jobs: [OVERDUE_JOB], employees: [] });
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.body).toEqual({ checked: 1, alerted: 1, failed: 0, failures: [] });
    const resendCall = fetchMock.mock.calls.find(([url]) => String(url).includes('resend.com'));
    expect(resendCall).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('returns 500 with a safe generic message (not the raw error) when the jobs lookup itself throws', async () => {
    // Regression guard for the error-handling audit (docs/audits/2026-08-16-error-handling.md):
    // this endpoint used to return err.message verbatim in the response body.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Internal error while checking for missed leads.');
    expect(res.body.error).not.toContain('network down');
    vi.unstubAllGlobals();
  });
});
