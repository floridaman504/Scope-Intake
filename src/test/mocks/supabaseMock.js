// A hand-rolled mock of the app's supabase client (src/supabaseClient.js),
// not a network stub -- no request ever leaves the process. Tests import
// `mockSupabase` and use vi.mock('../supabaseClient.js', () => ({ supabase:
// mockSupabase })) to swap it in. `resetSupabaseMock()` in a beforeEach
// wipes call history AND configured responses between tests so one test's
// setup can't leak into the next.
//
// Named `mockSupabase` (not `supabase`) on purpose: Vitest hoists vi.mock()
// factories above imports, and only allows referencing outer variables
// whose name starts with `mock` from inside a hoisted factory. Anything
// else throws "cannot access before initialization" at collection time.
import { vi } from 'vitest';

function createChainable(getResponse) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve(getResponse())),
    maybeSingle: vi.fn(() => Promise.resolve(getResponse())),
    // `session_policy` is awaited directly after .select(), with no
    // .single()/.eq() in between (see AuthContext.jsx), so the chain link
    // itself has to be thenable.
    then: (resolve, reject) => Promise.resolve(getResponse()).then(resolve, reject),
    catch: (onReject) => Promise.resolve(getResponse()).catch(onReject),
  };
  return chain;
}

export const mockSupabase = {
  auth: {
    getSession: vi.fn(),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    updateUser: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    onAuthStateChange: vi.fn(),
  },
  from: vi.fn(),
  rpc: vi.fn(),
  channel: vi.fn(),
  removeChannel: vi.fn(),
};

let tableResponses = {};
let rpcResponses = {};
let authStateListeners = [];

// Configure what `supabase.from(table)...` resolves to. `response` can be
// a plain { data, error } object or a function of the query chain's state
// (currently unused by any test, kept simple: last-call-wins per table).
export function setTableResponse(table, response) {
  tableResponses[table] = response;
}

export function setRpcResponse(fnName, response) {
  rpcResponses[fnName] = response;
}

// Lets a test simulate Supabase pushing an auth event (e.g. a token
// refresh failing elsewhere and the client going to SIGNED_OUT) the same
// way supabase.auth.onAuthStateChange's real callback would fire.
export function fireAuthStateChange(event, session) {
  authStateListeners.forEach((cb) => cb(event, session));
}

export function resetSupabaseMock() {
  tableResponses = {};
  rpcResponses = {};
  authStateListeners = [];

  mockSupabase.auth.getSession.mockReset().mockResolvedValue({ data: { session: null } });
  mockSupabase.auth.signInWithPassword.mockReset().mockResolvedValue({ data: {}, error: null });
  mockSupabase.auth.signUp.mockReset().mockResolvedValue({ data: {}, error: null });
  mockSupabase.auth.signOut.mockReset().mockResolvedValue({ error: null });
  mockSupabase.auth.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
  mockSupabase.auth.resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null });
  mockSupabase.auth.onAuthStateChange.mockReset().mockImplementation((cb) => {
    authStateListeners.push(cb);
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });

  mockSupabase.from.mockReset().mockImplementation((table) =>
    createChainable(() => tableResponses[table] ?? { data: null, error: null })
  );

  mockSupabase.rpc.mockReset().mockImplementation((fnName) =>
    Promise.resolve(rpcResponses[fnName] ?? { data: null, error: null })
  );

  mockSupabase.channel.mockReset().mockImplementation(() => {
    const channelObj = {
      on: vi.fn(() => channelObj),
      subscribe: vi.fn(() => channelObj),
    };
    return channelObj;
  });

  mockSupabase.removeChannel.mockReset();
}
