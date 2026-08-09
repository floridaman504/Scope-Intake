#!/usr/bin/env node
/**
 * Pre-commit secret scanner for Scope.
 *
 * Two layers:
 *  1. Hard block on staging any real .env-style file (only .env.example is allowed).
 *  2. Regex scan of the ADDED lines in this commit for common secret shapes
 *     (Anthropic keys, AWS keys, Stripe keys, generic api_key/secret/password/token
 *     assignments, private key blocks, and Supabase service_role JWTs).
 *
 * If the `gitleaks` binary is installed and on PATH, we also run it as a stronger
 * primary check (better entropy analysis, maintained ruleset); this regex scan
 * acts as a zero-dependency fallback/backstop either way.
 *
 * Exit code 1 blocks the commit. This hook is installed via husky (see
 * .husky/pre-commit) and runs automatically on `git commit` for anyone who
 * clones the repo and runs `npm install`.
 */
import { execSync, spawnSync } from 'node:child_process';

const BLOCKED_ENV_FILE = /(^|\/)\.env(\.[^.]+)?$/;
const ALLOWED_ENV_FILE = /(^|\/)\.env\.example$/;

const SECRET_PATTERNS = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /sk-[A-Za-z0-9]{32,}/ },
  { name: 'Stripe live key', re: /sk_live_[0-9a-zA-Z]{16,}/ },
  { name: 'AWS access key ID', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Supabase service_role JWT', re: /"role"\s*:\s*"service_role"/ },
  { name: 'Generic private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: 'Hardcoded secret/token/password assignment',
    re: /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+]{12,}['"]/i,
  },
];

function getStagedFiles() {
  const out = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function getAddedLines(file) {
  const out = execSync(`git diff --cached -U0 -- ${JSON.stringify(file)}`, { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

let failed = false;
const findings = [];

// 1. Block real .env files outright.
for (const file of getStagedFiles()) {
  if (BLOCKED_ENV_FILE.test(file) && !ALLOWED_ENV_FILE.test(file)) {
    failed = true;
    findings.push(`  ${file}: committing a real .env file is blocked. Only .env.example may be tracked.`);
  }
}

// 2. Prefer gitleaks if it's installed (better detection); otherwise fall back to regex.
const gitleaks = spawnSync('gitleaks', ['protect', '--staged', '--redact', '--no-banner'], {
  encoding: 'utf8',
});

if (!gitleaks.error) {
  if (gitleaks.status !== 0) {
    failed = true;
    findings.push('  gitleaks detected a likely secret in staged changes:');
    findings.push((gitleaks.stdout || gitleaks.stderr || '').trim());
  }
} else {
  // gitleaks not installed -- run the built-in regex fallback.
  for (const file of getStagedFiles()) {
    if (BLOCKED_ENV_FILE.test(file)) continue; // already handled above
    let lines;
    try {
      lines = getAddedLines(file);
    } catch {
      continue; // binary file, deleted file, etc.
    }
    for (const line of lines) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(line)) {
          failed = true;
          findings.push(`  ${file}: possible ${name} — "${line.trim().slice(0, 80)}"`);
        }
      }
    }
  }
}

if (failed) {
  console.error('\n✖ Commit blocked: possible secret detected.\n');
  console.error(findings.join('\n'));
  console.error(
    '\nIf this is a false positive, move the value into an environment variable ' +
      '(see .env.example) instead of hardcoding it, or adjust the pattern in scripts/scan-secrets.js.\n',
  );
  process.exit(1);
}

process.exit(0);
