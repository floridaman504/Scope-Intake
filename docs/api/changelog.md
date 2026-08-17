# API changelog

Tracks changes to Scope's public-facing API surface (`docs/api/v1.md`).
Not every code change to `api/*.js` belongs here -- only changes that
affect what a caller sends or receives.

**Policy:** an additive, non-breaking change (new optional field, new
endpoint) gets a dated entry under the current version. A breaking
change (removed field, changed field meaning, new required input) ships
as a new version living alongside the old one, never as a silent change
underneath existing callers. See
`docs/audits/2026-08-17-api-security-and-versioning.md` for the full
reasoning.

## v1

### 2026-08-17 -- v1 introduced

First versioned release. Both existing endpoints moved from unversioned
paths to `/v1/`:

- `/api/review-job` -> `/api/v1/review-job`
- `/api/check-missed-leads` -> `/api/v1/check-missed-leads`

No behavior changed -- request/response shapes, auth requirements, and
error handling are identical to what shipped before this date. See
`docs/api/v1.md` for the full current reference.
