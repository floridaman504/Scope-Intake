# Secrets Audit — 2026-08-06

## Scope
Full working tree and full `git log --all -p` history (every commit, both
`main` and `scopwell-preview`) scanned for hardcoded API keys, tokens,
passwords, connection strings, and JWTs.

## Findings

**No hardcoded secrets found**, in the current tree or in any prior commit
on either branch. Both `src/supabaseClient.js` and `api/review-job.js`
correctly source credentials from environment variables
(`import.meta.env.VITE_*` on the client, `process.env.ANTHROPIC_API_KEY`
server-side only in the Vercel function). The Supabase anon key is the only
credential ever exposed to the browser, which is expected and safe by
design — it only permits what RLS policies allow.

**Gaps found and fixed in this branch (`tier1-security-audit`):**

| Gap | Fix |
|---|---|
| No `.gitignore` existed at all — nothing stopped a future `.env` from being committed by accident. | Added `.gitignore` covering `.env*`, `node_modules/`, `dist/`, `.vercel`. |
| No `.env.example` — no documented list of what env vars the app needs. | Added `.env.example` with placeholder values and comments on where each value comes from and whether it's client- or server-side. |
| No secret-scanning of any kind. | Added a local pre-commit hook (`scripts/scan-secrets.js`, wired via husky) **and** a GitHub Action (`.github/workflows/gitleaks.yml`) as a server-side backstop. |

## Why both a pre-commit hook and a GitHub Action

Your commit history (`git log --oneline`) shows a lot of `Add files via
upload` commits — that's GitHub's web upload UI, not a local `git commit`.
**A local pre-commit hook does nothing for a commit made through the GitHub
website** — there's no local git client involved, so no hook ever runs.

So: the pre-commit hook protects you when you (or I) commit from a local
clone or from an IDE with git integration. The GitHub Action protects you
regardless of how the commit was made, including web uploads, and also
catches anything pushed with `git commit --no-verify` (which bypasses hooks
deliberately or accidentally). Treat the Action as the real backstop and the
hook as a fast, no-network first pass.

## Pre-commit hook — verified

Tested against two cases:
1. Staging a file containing a dummy `sk_live_...` Stripe-style key →
   commit blocked.
2. Staging a real `.env` file (even with `git add -f`) → commit blocked
   outright, regardless of content.

A clean commit (the hook infra itself) passed through normally.

The hook prefers the `gitleaks` binary if it's installed locally (better
entropy-based detection, maintained ruleset) and falls back to a built-in
regex scanner (Anthropic/OpenAI/Stripe/AWS/Google key shapes, generic
`api_key=`/`secret=`/`password=` assignments, PEM private key blocks,
Supabase `service_role` JWTs) if it isn't. Nothing extra to install for the
hook to work at all — `npm install` is enough.

## Setup for a fresh clone

```
npm install        # also installs the pre-commit hook via husky's "prepare" script
cp .env.example .env
# fill in real values in .env (never commit this file)
```

## Recommendation

Install `gitleaks` locally (`brew install gitleaks` or see
https://github.com/gitleaks/gitleaks) for stronger local scanning — the
regex fallback is a safety net, not a replacement for it.
