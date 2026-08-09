# Scope

Plumbing/trades dispatcher intake tool. Customer-facing intake form +
Supabase-backed job storage, with a role-based (Owner / Dispatcher /
Plumber) dispatch dashboard.

Live: https://scope-intake.vercel.app

## Local setup

```
npm install
cp .env.example .env   # fill in real Supabase values
npm run dev
```

`npm install` also wires up the pre-commit secret-scan hook (see
`docs/audits/2026-08-06-secrets-audit.md`) via husky. No manual hook setup
needed.

## Environment variables

See `.env.example` for the full list and where each value comes from.
Never commit a real `.env` file — the pre-commit hook and CI will both
block it.

## Security

Secret-scanning runs locally on commit and again in CI on every push (see
`.github/workflows/gitleaks.yml`). Audit reports live in `docs/audits/`.
