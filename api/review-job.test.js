// Tests for the AI job-review endpoint (api/review-job.js).
// Same no-real-network-call approach as api/check-missed-leads.test.js:
// @supabase/supabase-js is mocked so check_rate_limit/log_ai_usage never
// leave the process, and global fetch is stubbed for the one real network
// call this handler makes (the Anthropic API). Focus here is the input
// validation block added for the Tier 2 #9 input-limits audit finding
// (docs/scope-operational-playbook.md) -- this endpoint is public and
// unauthenticated, so it's the one place a completely untrusted request
// body reaches the server directly.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ rpc: rpcMock }),
}));

import handler from './review-job.js';

const ENV = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'anon-key',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
};

function makeReq(body, method = 'POST') {
  return { method, body, headers: {}, socket: {} };
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

const VALID_BRIEF = {
  jobType: 'Leaking pipe',
  urgency: 'Medium',
  likelyMaterials: ['PEX fitting'],
  briefSummary: 'Customer reports a slow leak under the kitchen sink.',
  watchOutFor: 'Check for hidden water damage in the cabinet base.',
};

function anthropicOkResponse() {
  return Promise.resolve({
    ok: true,
    json: async () => ({
      content: [{ text: JSON.stringify(VALID_BRIEF) }],
      usage: { input_tokens: 120, output_tokens: 80 },
    }),
  });
}

describe('review-job handler', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
    rpcMock.mockReset();
    // Default: rate limit check passes (no limitCode), usage log succeeds.
    rpcMock.mockImplementation((fn) => {
      if (fn === 'check_rate_limit') return Promise.resolve({ data: null, error: null });
      if (fn === 'log_ai_usage') return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('rejects methods other than POST', async () => {
    const res = makeRes();
    await handler(makeReq({}, 'GET'), res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects a missing summary', async () => {
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/summary is required/);
  });

  it('rejects a blank (whitespace-only) summary', async () => {
    const res = makeRes();
    await handler(makeReq({ summary: '   ' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/summary is required/);
  });

  it('rejects a non-string summary', async () => {
    const res = makeRes();
    await handler(makeReq({ summary: 12345 }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/summary is required/);
  });

  it('rejects a summary over 6000 characters', async () => {
    const res = makeRes();
    await handler(makeReq({ summary: 'a'.repeat(6001) }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/summary is too long/);
  });

  it('accepts a summary at exactly 6000 characters (boundary)', async () => {
    vi.stubGlobal('fetch', vi.fn(anthropicOkResponse));
    const res = makeRes();
    await handler(makeReq({ summary: 'a'.repeat(6000) }), res);
    expect(res.statusCode).toBe(200);
    vi.unstubAllGlobals();
  });

  it.each([
    ['non-integer', 1.5],
    ['negative', -1],
    ['too large', 9],
    ['a string', '3'],
  ])('rejects an invalid mediaCount (%s)', async (_label, mediaCount) => {
    const res = makeRes();
    await handler(makeReq({ summary: 'Leak under sink', mediaCount }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/mediaCount is invalid/);
  });

  it('accepts mediaCount at the 8-file boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(anthropicOkResponse));
    const res = makeRes();
    await handler(makeReq({ summary: 'Leak under sink', mediaCount: 8 }), res);
    expect(res.statusCode).toBe(200);
    vi.unstubAllGlobals();
  });

  it('rejects a non-string mediaTypes', async () => {
    const res = makeRes();
    await handler(makeReq({ summary: 'Leak under sink', mediaTypes: 42 }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/mediaTypes is invalid/);
  });

  it('rejects a mediaTypes string over 200 characters', async () => {
    const res = makeRes();
    await handler(makeReq({ summary: 'Leak under sink', mediaTypes: 'image, '.repeat(40) }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/mediaTypes is invalid/);
  });

  it('rejects a non-string subdomain', async () => {
    const res = makeRes();
    await handler(makeReq({ summary: 'Leak under sink', subdomain: 42 }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/subdomain is invalid/);
  });

  it('rejects a subdomain string over 100 characters', async () => {
    const res = makeRes();
    await handler(makeReq({ summary: 'Leak under sink', subdomain: 'a'.repeat(101) }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/subdomain is invalid/);
  });

  it('still works with mediaCount/mediaTypes/subdomain all omitted (all optional)', async () => {
    vi.stubGlobal('fetch', vi.fn(anthropicOkResponse));
    const res = makeRes();
    await handler(makeReq({ summary: 'Leak under sink' }), res);
    expect(res.statusCode).toBe(200);
    vi.unstubAllGlobals();
  });

  it('returns the parsed brief on the happy path', async () => {
    vi.stubGlobal('fetch', vi.fn(anthropicOkResponse));
    const res = makeRes();
    await handler(makeReq({ summary: 'Leak under sink', mediaCount: 2, mediaTypes: 'image, image', subdomain: 'demo' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(VALID_BRIEF);
    vi.unstubAllGlobals();
  });

  it('returns 429 when check_rate_limit reports a limit', async () => {
    rpcMock.mockImplementation((fn) => {
      if (fn === 'check_rate_limit') return Promise.resolve({ data: 'rate_limited_ip', error: null });
      return Promise.resolve({ data: null, error: null });
    });
    const res = makeRes();
    await handler(makeReq({ summary: 'Leak under sink' }), res);
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('rate_limited_ip');
  });

  it('proceeds (fail-open) when check_rate_limit itself errors', async () => {
    rpcMock.mockImplementation((fn) => {
      if (fn === 'check_rate_limit') return Promise.resolve({ data: null, error: { message: 'db down' } });
      return Promise.resolve({ data: null, error: null });
    });
    vi.stubGlobal('fetch', vi.fn(anthropicOkResponse));
    const res = makeRes();
    await handler(makeReq({ summary: 'Leak under sink' }), res);
    expect(res.statusCode).toBe(200);
    vi.unstubAllGlobals();
  });

  it('returns 500 with the Anthropic error message when the AI call errors', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({ error: { message: 'overloaded_error' } }),
    })));
    const res = makeRes();
    await handler(makeReq({ summary: 'Leak under sink' }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('overloaded_error');
    vi.unstubAllGlobals();
  });
});
