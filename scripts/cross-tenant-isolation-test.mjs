#!/usr/bin/env node
// Task #23 (P1): automated cross-tenant isolation test.
//
// What this proves: that a logged-in employee of Company A can never see,
// modify, or delete Company B's data, and that the public intake form's
// anon INSERT can't be read back by anon afterward -- exercising the SAME
// RLS policies and grants that protect production (see
// docs/schema/production-schema-2026-08-09.sql and
// docs/audits/2026-08-06-cross-tenant-isolation-audit.md), not a mock of
// them.
//
// Why direct Postgres instead of driving the app / Supabase Auth: a real
// sign-in flow needs GoTrue admin calls, confirmed emails, and JWT minting
// -- slow and flaky for something that should run on every push. Instead
// this connects straight to Postgres and does exactly what PostgREST does
// per-request: `SET LOCAL ROLE authenticated` (or `anon`) plus
// `SET LOCAL request.jwt.claim.sub = '<uuid>'`, which is precisely what
// `auth.uid()` reads (confirmed live against scope-staging while building
// this -- see auth.uid()'s definition: it checks request.jwt.claim.sub
// first, falling back to request.jwt.claims). Every policy in production
// keys off auth.uid() via get_my_company_id()/get_my_role(), so this
// exercises the real thing.
//
// Blast-radius control: everything below runs inside ONE
// `BEGIN ... ROLLBACK`, with the ROLLBACK in a `finally` so it fires even
// if an assertion throws or the script crashes -- scope-staging is never
// left holding residual test rows, pass or fail.
//
// This must only ever run against scope-staging, never production:
//   - It only ever reads STAGING_DB_URL (never SUPABASE_DB_URL) -- the
//     workflow that calls this script is never given the production
//     secret at all, so there's no value this script could even
//     misread.
//   - It refuses to proceed if the target database's `companies` table
//     already holds more rows than a staging (schema-only, no customer
//     data) environment ever legitimately should. Production currently
//     has real customers in it; staging should always start empty.
//
// Usage: STAGING_DB_URL=postgres://... node scripts/cross-tenant-isolation-test.mjs

import pg from 'pg';

const STAGING_SAFETY_CEILING = 20; // generous; real staging starts at 0

const dbUrl = process.env.STAGING_DB_URL;
if (!dbUrl) {
  console.error('Missing STAGING_DB_URL. Refusing to run -- this test only ever targets scope-staging.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });

// Fixed UUIDs so failures are easy to grep for in staging if the rollback
// somehow didn't fire (it always should -- see finally block below).
const IDS = {
  companyA: '00000000-c1a0-0000-0000-000000000001',
  companyB: '00000000-c1b0-0000-0000-000000000002',
  ownerA: '00000000-a000-0000-0000-00000000a001',
  dispatcherA: '00000000-a000-0000-0000-00000000a002',
  ownerB: '00000000-a000-0000-0000-00000000a003',
  jobA1: '00000000-1a00-0000-0000-000000001a01',
  jobA2: '00000000-1a00-0000-0000-000000001a02',
  jobB1: '00000000-1b00-0000-0000-000000001b01',
};

const results = [];

function check(name, actual, expected) {
  const pass = actual === expected;
  results.push({ name, actual, expected, pass });
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function scalar(sql, params) {
  const { rows } = await client.query(sql, params);
  const val = Object.values(rows[0])[0];
  return val;
}

// For checks that expect a query to be REJECTED outright (permission
// denied on a table with zero grants, e.g. `companies`) rather than
// merely returning zero rows (the RLS-filtered case, which `scalar()`
// above handles fine). A raw failed query aborts the whole Postgres
// transaction -- every later statement fails with "current transaction
// is aborted" until a ROLLBACK -- so this wraps the attempt in a
// SAVEPOINT and rolls back to it on the expected error, letting the rest
// of the test's single BEGIN...ROLLBACK transaction keep going.
async function expectDenied(sql, params) {
  await client.query('savepoint expect_denied;');
  try {
    await client.query(sql, params);
    return false; // no error was thrown -- the check should fail
  } catch (err) {
    await client.query('rollback to savepoint expect_denied;');
    return err.code === '42501'; // permission denied
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_RE = /^[a-z_]+$/;

// `SET`/`SET LOCAL` are Postgres utility statements, not regular queries --
// they don't accept bind parameters ($1) the way SELECT/INSERT/etc do (the
// `pg` driver still sends them through the extended query protocol, which
// Postgres rejects for SET with "syntax error at or near $1" -- this is
// exactly what broke on the first CI run). So this inlines the value
// directly instead. Safe here because `role` and `sub` are never anything
// but this script's own hardcoded constants (role names and the fixed IDS
// UUIDs above) -- never external input -- and the regex checks below are a
// defense-in-depth belt on top of that, not the only thing standing
// between this and injection.
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

  // ---- Arrange: two throwaway tenants, entirely as postgres (bypasses RLS) ----
  await client.query(
    `insert into companies (id, name, subdomain) values ($1, 'CI Isolation Test Co A', 'citest-a-ci'), ($2, 'CI Isolation Test Co B', 'citest-b-ci')`,
    [IDS.companyA, IDS.companyB]
  );

  await client.query(
    `insert into auth.users (id, email, aud, role) values
       ($1, 'owner-a@citest.local', 'authenticated', 'authenticated'),
       ($2, 'dispatcher-a@citest.local', 'authenticated', 'authenticated'),
       ($3, 'owner-b@citest.local', 'authenticated', 'authenticated')`,
    [IDS.ownerA, IDS.dispatcherA, IDS.ownerB]
  );

  await client.query(
    `insert into employees (user_id, email, full_name, role, company_id) values
       ($1, 'owner-a@citest.local', 'CI Owner A', 'owner', $4),
       ($2, 'dispatcher-a@citest.local', 'CI Dispatcher A', 'dispatcher', $4),
       ($3, 'owner-b@citest.local', 'CI Owner B', 'owner', $5)`,
    [IDS.ownerA, IDS.dispatcherA, IDS.ownerB, IDS.companyA, IDS.companyB]
  );

  await client.query(
    `insert into jobs (id, company_id, customer_name, context) values
       ($1, $4, 'CI Job A1', 'citest'),
       ($2, $4, 'CI Job A2', 'citest'),
       ($3, $5, 'CI Job B1', 'citest')`,
    [IDS.jobA1, IDS.jobA2, IDS.jobB1, IDS.companyA, IDS.companyB]
  );

  await client.query(
    `insert into invite_codes (code, company_id, role) values ('CITEST-A', $1, 'plumber'), ('CITEST-B', $2, 'plumber')`,
    [IDS.companyA, IDS.companyB]
  );

  await client.query(
    `insert into ai_usage_log (company_id, subdomain, input_tokens, output_tokens, estimated_cost_usd) values
       ($1, 'citest-a-ci', 10, 10, 0.01), ($2, 'citest-b-ci', 10, 10, 0.01)`,
    [IDS.companyA, IDS.companyB]
  );

  // ---- Act + Assert, as Tenant A's owner ----
  await asRole('authenticated', IDS.ownerA);

  check(
    'tenant_a_owner sees exactly their own 2 jobs',
    await scalar(`select count(*) from jobs where context = 'citest'`),
    '2'
  );

  check(
    'tenant_a_owner cannot see tenant B job by id',
    await scalar(`select count(*) from jobs where id = $1`, [IDS.jobB1]),
    '0'
  );

  check(
    'tenant_a_owner cannot see tenant B employees',
    await scalar(`select count(*) from employees where company_id = $1`, [IDS.companyB]),
    '0'
  );

  check(
    'tenant_a_owner cannot see tenant B invite codes',
    await scalar(`select count(*) from invite_codes where company_id = $1`, [IDS.companyB]),
    '0'
  );

  check(
    'tenant_a_owner cannot see tenant B ai_usage_log rows',
    await scalar(`select count(*) from ai_usage_log where company_id = $1`, [IDS.companyB]),
    '0'
  );

  // `companies` has ZERO grants at all for `authenticated` (not just an
  // RLS policy filtering rows to nothing) -- so this fails outright with
  // Postgres error 42501 (permission denied) rather than returning 0 rows.
  // Confirmed live on the first real CI run against scope-staging: the
  // count(*)-based check pattern used for every other table doesn't apply
  // here, the query never even executes. Uses expectDenied() (SAVEPOINT-
  // wrapped) rather than a bare try/catch so the transaction can keep
  // going afterward instead of aborting for every remaining statement.
  check(
    'tenant_a_owner SELECT on companies is rejected outright (zero grants, deny-all by design)',
    await expectDenied(`select count(*) from companies where id in ($1, $2)`, [IDS.companyA, IDS.companyB]),
    true
  );

  await client.query(`update jobs set customer_name = 'HACKED-BY-CI-TEST' where id = $1`, [IDS.jobB1]);
  check(
    'tenant_a_owner UPDATE against tenant B job has zero effect',
    await scalar(`select count(*) from jobs where id = $1 and customer_name = 'HACKED-BY-CI-TEST'`, [IDS.jobB1]),
    '0'
  );

  await client.query(`delete from jobs where id = $1`, [IDS.jobB1]);
  check(
    'tenant_a_owner DELETE against tenant B job has zero effect',
    await scalar(`select count(*) from jobs where id = $1`, [IDS.jobB1]),
    '1'
  );

  // ---- Act + Assert, as Tenant A's dispatcher (can UPDATE, cannot DELETE) ----
  await asRole('authenticated', IDS.dispatcherA);

  await client.query(`update jobs set status = 'claimed' where id = $1`, [IDS.jobA1]);
  check(
    "tenant_a_dispatcher CAN update tenant A's own job (role permits UPDATE)",
    await scalar(`select count(*) from jobs where id = $1 and status = 'claimed'`, [IDS.jobA1]),
    '1'
  );

  await client.query(`delete from jobs where id = $1`, [IDS.jobA1]);
  check(
    "tenant_a_dispatcher CANNOT delete tenant A's own job (owner-only policy)",
    await scalar(`select count(*) from jobs where id = $1`, [IDS.jobA1]),
    '1'
  );

  // ---- Act + Assert, as Tenant B's owner (symmetry check -- not just A->B) ----
  await asRole('authenticated', IDS.ownerB);

  check(
    'tenant_b_owner sees exactly their own 1 job',
    await scalar(`select count(*) from jobs where context = 'citest'`),
    '1'
  );

  check(
    'tenant_b_owner cannot see tenant A jobs',
    await scalar(`select count(*) from jobs where company_id = $1`, [IDS.companyA]),
    '0'
  );

  await client.query(`delete from jobs where id = $1`, [IDS.jobA2]);
  check(
    "tenant_b_owner DELETE against tenant A's job has zero effect",
    await scalar(`select count(*) from jobs where id = $1`, [IDS.jobA2]),
    '1'
  );

  // ---- Act + Assert, as anon (public intake form) ----
  await asRole('anon', null);

  await client.query(
    `insert into jobs (id, company_id, customer_name, context) values ($1, $2, 'CI Anon Job', 'citest-anon')`,
    ['00000000-1a00-0000-0000-00000000a0aa', IDS.companyA]
  );
  check(
    'anon INSERT into jobs for a real company succeeds (public intake form path)',
    await scalar(`select count(*) from jobs where id = '00000000-1a00-0000-0000-00000000a0aa'`),
    '1'
  );

  check(
    'anon cannot read back the job it just inserted (no SELECT grant)',
    await scalar(`select count(*) from jobs where context = 'citest-anon'`),
    '0'
  );

  check(
    'anon SELECT on employees is rejected outright (no grant at all)',
    await expectDenied('select * from employees limit 1;'),
    true
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
  console.error('Cross-tenant isolation test crashed:', err);
  ok = false;
} finally {
  // Always roll back, pass, fail, or crash -- scope-staging must never
  // retain any of this script's test data.
  try {
    await client.query('rollback;');
    console.log('Rolled back -- scope-staging left untouched.');
  } catch (rollbackErr) {
    console.error('WARNING: rollback itself failed. Staging may have residual CI test data (subdomains citest-a-ci / citest-b-ci). Manual cleanup may be needed.', rollbackErr);
  }
  await client.end();
}

process.exit(ok ? 0 : 1);
