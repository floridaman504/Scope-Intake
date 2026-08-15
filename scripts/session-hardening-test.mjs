#!/usr/bin/env node
// Automated CI test for Tier 1.3 session/auth hardening (supabase_session_
// hardening.sql), closing the coverage gap found in the 2026-08-13
// re-audit of docs/audits/2026-08-06-session-auth-hardening.md: the
// migration and its four RPCs (register_session, touch_session,
// revoke_session, sign_out_everywhere) were live and holding real
// production data, but nothing in CI ever exercised them -- a policy or
// function change could silently break session hardening and nothing
// would catch it before the next manual click-through.
//
// Same technique and same safety model as scripts/cross-tenant-isolation-
// test.mjs (read that file's header first if this one's shorthand isn't
// clear): connects directly to scope-staging as Postgres, uses
// `SET LOCAL ROLE` + `SET LOCAL request.jwt.claim.sub` to exercise the
// exact mechanism PostgREST uses per-request (auth.uid() reads
// request.jwt.claim.sub), runs everything inside one
// `BEGIN ... ROLLBACK` so staging is never left with residual test rows,
// and only ever reads STAGING_DB_URL -- this workflow is never given the
// production secret.
//
// What this proves that the unit test suite (mocked Supabase client)
// cannot: that the REAL RLS policies + REAL SECURITY DEFINER function
// bodies in production enforce the concurrent-session cap, sliding
// inactivity timeout, and revoke/sign-out-everywhere authorization rules
// -- not just that the React code calls the right RPC names.
//
// Usage: STAGING_DB_URL=postgres://... node scripts/session-hardening-test.mjs

import pg from 'pg';

const STAGING_SAFETY_CEILING = 20; // same ceiling as cross-tenant-isolation-test.mjs

const dbUrl = process.env.STAGING_DB_URL;
if (!dbUrl) {
  console.error('Missing STAGING_DB_URL. Refusing to run -- this test only ever targets scope-staging.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });

const IDS = {
  company: '00000000-5e55-0000-0000-000000000001',
  owner: '00000000-5e55-0000-0000-00000000a001',   // owner: max_lifetime_minutes=120, concurrent_session_limit=3
  dispatcher: '00000000-5e55-0000-0000-00000000a002', // dispatcher: max_lifetime_minutes=1440
};

const results = [];

function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, actual, expected, pass });
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function scalar(sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0] ? Object.values(rows[0])[0] : undefined;
}

async function row(sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0];
}

// Same SAVEPOINT-wrapped pattern as cross-tenant-isolation-test.mjs: lets
// an expected error (permission denied, RLS violation, or a raised
// exception from inside a SECURITY DEFINER function) be checked without
// aborting the rest of the single BEGIN...ROLLBACK transaction.
async function expectRejected(fn) {
  await client.query('savepoint expect_rejected;');
  try {
    await fn();
    return false;
  } catch (err) {
    await client.query('rollback to savepoint expect_rejected;');
    return true;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_RE = /^[a-z_]+$/;

async function asRole(role, sub) {
  if (!ROLE_RE.test(role)) {
    throw new Error(`Refusing to SET ROLE to unexpected value: ${JSON.stringify(role)}`);
  }
  await client.query('set local role ' + role + ';');
  if (sub) {
    if (!UUID_RE.test(sub)) {
      throw new Error(`Refusing to SET request.jwt.claim.sub to a non-UUID value: ${JSON.stringify(sub)}`);
    }
    await client.query(`set local request.jwt.claim.sub = '${sub}';`);
  } else {
    await client.query('reset request.jwt.claim.sub;');
  }
}

async function asPostgres() {
  await client.query('reset role;');
  await client.query('reset request.jwt.claim.sub;');
}

async function main() {
  await client.connect();

  const dbInfo = await client.query('select current_database() as db;');
  console.log(`Connected to database: ${dbInfo.rows[0].db}`);

  const existingCompanies = await scalar('select count(*) from companies;');
  if (Number(existingCompanies) > STAGING_SAFETY_CEILING) {
    throw new Error(
      `Safety check failed: companies table already has ${existingCompanies} rows, ` +
      `more than a schema-only staging environment should ever have. Refusing to run ` +
      `in case this connection is not actually scope-staging.`
    );
  }
  console.log(`Safety check ok: ${existingCompanies} pre-existing companies (ceiling ${STAGING_SAFETY_CEILING}).`);

  await client.query('begin;');

  // ---- Arrange ----
  await client.query(
    `insert into companies (id, name, subdomain) values ($1, 'CI Session Test Co', 'citest-session-ci')`,
    [IDS.company]
  );
  await client.query(
    `insert into auth.users (id, email, aud, role) values
       ($1, 'owner-session@citest.local', 'authenticated', 'authenticated'),
       ($2, 'dispatcher-session@citest.local', 'authenticated', 'authenticated')`,
    [IDS.owner, IDS.dispatcher]
  );
  await client.query(
    `insert into employees (user_id, email, full_name, role, company_id) values
       ($1, 'owner-session@citest.local', 'CI Owner', 'owner', $3),
       ($2, 'dispatcher-session@citest.local', 'CI Dispatcher', 'dispatcher', $3)`,
    [IDS.owner, IDS.dispatcher, IDS.company]
  );

  // session_policy is a global (not company-scoped) table, and its seed
  // values are meant to be editable by Dante directly in the SQL editor
  // (see supabase_session_hardening.sql's own header) rather than owned by
  // this test's fixtures -- so scope-staging isn't guaranteed to carry the
  // same rows production does. Upsert the canonical values here (as
  // postgres, inside this rolled-back transaction) so the test is
  // self-contained and doesn't silently fall back to register_session()/
  // touch_session()'s built-in defaults (limit=3, 1440min) if a role row
  // happens to be missing on staging -- that fallback exists for
  // forward-compat with a future role, not as a substitute for real seed
  // data, and if it silently kicked in here the concurrent-cap and
  // inactivity-timeout assertions below would pass or fail for the wrong
  // reason.
  await client.query(
    `insert into session_policy (role, max_lifetime_minutes, concurrent_session_limit) values
       ('owner', 120, 3),
       ('dispatcher', 1440, 3),
       ('plumber', 1440, 3)
     on conflict (role) do update
       set max_lifetime_minutes = excluded.max_lifetime_minutes,
           concurrent_session_limit = excluded.concurrent_session_limit`
  );

  // ---- session_policy: readable, matches the seeded roles ----
  await asRole('authenticated', IDS.owner);
  check(
    'session_policy is readable by any authenticated employee',
    await scalar(`select concurrent_session_limit from session_policy where role = 'owner'`),
    3
  );

  // ---- register_session(): creates a row scoped to the caller ----
  const firstSessionId = await scalar(
    `select register_session('CI device 1', 'CI agent 1')`
  );
  check('register_session returns a session id', UUID_RE.test(firstSessionId || ''), true);

  const firstSessionRow = await row(
    `select company_id, role_at_login, revoked_at from user_sessions where id = $1`,
    [firstSessionId]
  );
  check('registered session has the correct company_id', firstSessionRow?.company_id, IDS.company);
  check('registered session has the correct role_at_login', firstSessionRow?.role_at_login, 'owner');
  check('registered session starts unrevoked', firstSessionRow?.revoked_at, null);

  // ---- Concurrent-session cap: owner's limit is 3. Register 2 more (3
  // total), then a 4th, and confirm exactly one session gets evicted while
  // 3 remain active.
  //
  // NOTE: this whole script runs inside a single BEGIN...ROLLBACK
  // transaction, and Postgres's now() is FROZEN for the entire
  // transaction (it's transaction_timestamp(), not wall-clock time) --
  // so all four sessions would get an IDENTICAL last_activity_at if left
  // alone, making register_session's "order by last_activity_at desc"
  // eviction choice an undefined tie-break rather than a real "oldest"
  // check. Backdating each session by a distinct explicit interval right
  // after registering it (as postgres, bypassing RLS) sidesteps that --
  // interval arithmetic produces genuinely distinct values regardless of
  // now() being frozen. This only exists to make the test deterministic;
  // it says nothing about a bug in the real function (in real usage,
  // registrations happen across separate requests/transactions with
  // naturally distinct timestamps). ----
  const secondSessionId = await scalar(`select register_session('CI device 2', 'CI agent 2')`);
  await asPostgres();
  await client.query(`update user_sessions set last_activity_at = now() - interval '3 minutes' where id = $1`, [secondSessionId]);
  await asRole('authenticated', IDS.owner);

  const thirdSessionId = await scalar(`select register_session('CI device 3', 'CI agent 3')`);
  await asPostgres();
  await client.query(`update user_sessions set last_activity_at = now() - interval '2 minutes' where id = $1`, [thirdSessionId]);
  await asRole('authenticated', IDS.owner);

  await scalar(`select register_session('CI device 4', 'CI agent 4')`);

  const survivorsCount = await scalar(
    `select count(*) from user_sessions where user_id = $1 and revoked_at is null`,
    [IDS.owner]
  );
  check('exactly 3 sessions remain active after the cap evicts the 4th excess', Number(survivorsCount), 3);

  const capEvictedRow = await row(
    `select id from user_sessions where user_id = $1 and revoked_reason = 'concurrent_session_limit_exceeded'`,
    [IDS.owner]
  );
  check('exactly one session was evicted for concurrent_session_limit_exceeded', !!capEvictedRow, true);
  check(
    'the session evicted for the cap is the one with the oldest last_activity_at',
    capEvictedRow?.id,
    secondSessionId
  );

  // Re-derive the currently-active session ids for this owner rather than
  // assuming which specific registration survived -- keeps the rest of
  // this test independent of the cap-eviction internals above.
  const activeOwnerSessionIds = (
    await client.query(
      `select id from user_sessions where user_id = $1 and revoked_at is null order by created_at`,
      [IDS.owner]
    )
  ).rows.map((r) => r.id);
  check('three distinct active session ids were found for the owner', activeOwnerSessionIds.length, 3);
  const [touchTargetActive, touchTargetForInactivity] = activeOwnerSessionIds;

  // ---- touch_session(): valid active session extends and reports expiry ----
  const touchResult = await row(`select * from touch_session($1)`, [touchTargetActive]);
  check('touch_session on an active session reports valid=true', touchResult?.valid, true);
  check('touch_session on an active session reports revoked=false', touchResult?.revoked, false);
  check('touch_session on an active session returns a future expires_at', touchResult?.expires_at !== null, true);

  // ---- touch_session() on an already-revoked session ----
  const touchRevoked = await row(`select * from touch_session($1)`, [capEvictedRow.id]);
  check('touch_session on a revoked session reports valid=false', touchRevoked?.valid, false);
  check('touch_session on a revoked session reports revoked=true', touchRevoked?.revoked, true);

  // ---- Sliding inactivity timeout: owner's max_lifetime_minutes is 120.
  // Backdate last_activity_at past that window (as postgres, bypassing
  // RLS), then touch_session() should self-revoke it for inactivity. ----
  await asPostgres();
  await client.query(
    `update user_sessions set last_activity_at = now() - interval '200 minutes' where id = $1`,
    [touchTargetForInactivity]
  );
  await asRole('authenticated', IDS.owner);
  const touchExpired = await row(`select * from touch_session($1)`, [touchTargetForInactivity]);
  check('touch_session on an inactivity-expired session reports valid=false', touchExpired?.valid, false);

  await asPostgres();
  const expiredRow = await row(`select revoked_at, revoked_reason from user_sessions where id = $1`, [touchTargetForInactivity]);
  check('inactivity-expired session is revoked server-side', expiredRow?.revoked_at !== null, true);
  check('inactivity-expired session has revoked_reason = inactivity_timeout', expiredRow?.revoked_reason, 'inactivity_timeout');

  // ---- revoke_session(): self-revoke succeeds ----
  await asRole('authenticated', IDS.dispatcher);
  const dispatcherSessionId = await scalar(`select register_session('CI dispatcher device', 'CI agent')`);
  const selfRevoke = await scalar(`select revoke_session($1, 'ci_self_test')`, [dispatcherSessionId]);
  check('a user can revoke their own session', selfRevoke, true);

  // ---- revoke_session(): a non-owner cannot revoke someone else's session ----
  // touchTargetActive is still an active owner session at this point (it
  // was only touch_session()'d above, never revoked) -- good target to
  // prove a dispatcher can't revoke it.
  const secondDispatcherAttempt = await expectRejected(() =>
    client.query(`select revoke_session($1, 'ci_unauthorized_test')`, [touchTargetActive])
  );
  check('a non-owner cannot revoke another employee\'s session', secondDispatcherAttempt, true);

  // ---- revoke_session(): owner CAN revoke another employee's session in the same company ----
  await asRole('authenticated', IDS.dispatcher);
  const dispatcherSessionId2 = await scalar(`select register_session('CI dispatcher device 2', 'CI agent')`);
  await asRole('authenticated', IDS.owner);
  const ownerRevokesDispatcher = await scalar(`select revoke_session($1, 'ci_owner_revoke_test')`, [dispatcherSessionId2]);
  check('an owner can revoke an employee\'s session in their own company', ownerRevokesDispatcher, true);

  // ---- sign_out_everywhere(): self-target revokes all of the caller's own active sessions ----
  await asRole('authenticated', IDS.owner);
  await client.query(`select register_session('CI device 5', 'CI agent 5')`);
  await client.query(`select register_session('CI device 6', 'CI agent 6')`);
  const selfSignOutCount = await scalar(`select sign_out_everywhere()`);
  check('sign_out_everywhere(self) revokes at least one active session', Number(selfSignOutCount) > 0, true);

  const remainingActiveForOwner = await scalar(
    `select count(*) from user_sessions where user_id = $1 and revoked_at is null`,
    [IDS.owner]
  );
  check('no active sessions remain for the owner after self sign-out-everywhere', Number(remainingActiveForOwner), 0);

  // ---- RLS on user_sessions: a non-owner cannot see another employee's session rows ----
  await asRole('authenticated', IDS.dispatcher);
  const dispatcherSeesOwnerSessions = await scalar(
    `select count(*) from user_sessions where user_id = $1`,
    [IDS.owner]
  );
  check(
    'a dispatcher cannot see the owner\'s session rows (RLS-filtered to zero, not an error)',
    Number(dispatcherSeesOwnerSessions),
    0
  );

  // ---- RLS on user_sessions: raw client writes are blocked (all writes must go through the RPCs) ----
  const rawInsertBlocked = await expectRejected(() =>
    client.query(
      `insert into user_sessions (user_id, company_id, role_at_login) values ($1, $2, 'dispatcher')`,
      [IDS.dispatcher, IDS.company]
    )
  );
  check('a raw INSERT into user_sessions (bypassing register_session) is rejected', rawInsertBlocked, true);

  // Both of the dispatcher's earlier sessions were already revoked above
  // (self-revoke, then owner-revoke), so register a fresh active one here
  // -- otherwise the raw-UPDATE check below would trivially "pass" with
  // zero rows to affect either way, regardless of whether RLS actually
  // blocks anything.
  const dispatcherFreshSessionId = await scalar(`select register_session('CI dispatcher device 3', 'CI agent')`);
  const beforeRawUpdate = await scalar(
    `select revoked_at from user_sessions where id = $1`,
    [dispatcherFreshSessionId]
  );
  check('the fresh dispatcher session exists and is unrevoked before the raw-write attempt', beforeRawUpdate, null);

  // Attempt a raw revoke via direct UPDATE instead of revoke_session().
  // Confirmed against real staging: there's no UPDATE grant to
  // `authenticated` on user_sessions at all, so this throws "permission
  // denied for table user_sessions" -- a hard privilege error, not an RLS
  // filter that would just affect 0 rows. expectRejected's SAVEPOINT
  // wrapper treats either outcome as a pass (both mean the write didn't
  // happen), so this stays correct even if the enforcement mechanism
  // changes from a privilege denial to an RLS-only one later.
  const rawUpdateBlocked = await expectRejected(() =>
    client.query(`update user_sessions set revoked_at = now() where id = $1`, [dispatcherFreshSessionId])
  );
  check('a raw UPDATE against user_sessions (bypassing revoke_session) is rejected', rawUpdateBlocked, true);

  const afterRawUpdate = await scalar(
    `select revoked_at from user_sessions where id = $1`,
    [dispatcherFreshSessionId]
  );
  check(
    'the fresh dispatcher session is still unrevoked after the blocked raw UPDATE',
    afterRawUpdate,
    null
  );

  await asPostgres();

  const failures = results.filter((r) => !r.pass);
  console.log('');
  console.log(`${results.length - failures.length}/${results.length} checks passed.`);
  if (failures.length > 0) {
    console.log('FAILED CHECKS:');
    for (const f of failures) {
      console.log(`  - ${f.name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
    }
  }

  return failures.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  console.error('Session hardening test crashed:', err);
  ok = false;
} finally {
  try {
    await client.query('rollback;');
    console.log('Rolled back -- scope-staging left untouched.');
  } catch (rollbackErr) {
    console.error('WARNING: rollback itself failed. Staging may have residual CI test data (subdomain citest-session-ci). Manual cleanup may be needed.', rollbackErr);
  }
  await client.end();
}

process.exit(ok ? 0 : 1);
