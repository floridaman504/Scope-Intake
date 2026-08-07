#!/usr/bin/env bash
# Restore a Scope backup (produced by .github/workflows/supabase-backup.yml)
# into a target Postgres database. This is deliberately NOT wired to run
# against production automatically -- you pass the target connection string
# yourself, so there's no way to fat-finger a restore over live data.
#
# Two intended uses:
#   1. Restore drill (recommended monthly): restore into a disposable local
#      Postgres to prove the backup actually works. See "Restore test plan"
#      in docs/audits/2026-08-06-backup-strategy.md for a full walkthrough
#      using Docker.
#   2. Real disaster recovery: restore into a fresh empty Supabase project
#      (Supabase dashboard > New project), then point the app at it.
#      NEVER restore directly into a database you still care about without
#      confirming it's empty or that you intend to overwrite it -- pg_restore
#      will add to/conflict with existing data, it does not wipe first.
#
# Usage:
#   ./scripts/restore-backup.sh <path-to-scope-YYYY-MM-DD.dump.gpg> <target-db-url>
#
# Requires: gpg, pg_restore (postgresql-client) on your machine.
# The encryption passphrase must be in $BACKUP_ENCRYPTION_PASSPHRASE (same
# value as the GitHub Actions secret of the same name) -- export it in your
# shell before running this, don't hardcode it in a script or pass it as a
# bare CLI arg (shows up in shell history / `ps`).

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <path-to-scope-YYYY-MM-DD.dump.gpg> <target-db-url>" >&2
  echo "Example target-db-url for a local test Postgres:" >&2
  echo "  postgresql://postgres:postgres@localhost:5432/scope_restored" >&2
  exit 1
fi

ENCRYPTED_DUMP="$1"
TARGET_DB_URL="$2"

if [ ! -f "$ENCRYPTED_DUMP" ]; then
  echo "Error: file not found: $ENCRYPTED_DUMP" >&2
  exit 1
fi

if [ -z "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
  echo "Error: BACKUP_ENCRYPTION_PASSPHRASE is not set in your environment." >&2
  echo "export BACKUP_ENCRYPTION_PASSPHRASE='...' (same value as the GitHub secret), then re-run." >&2
  exit 1
fi

for cmd in gpg pg_restore; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is not installed. Install postgresql-client and gnupg." >&2
    exit 1
  fi
done

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

PLAIN_DUMP="$WORKDIR/$(basename "${ENCRYPTED_DUMP%.gpg}")"

echo "Decrypting $ENCRYPTED_DUMP ..."
gpg --batch --yes --decrypt --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
  -o "$PLAIN_DUMP" "$ENCRYPTED_DUMP"

echo "Verifying dump structure (pg_restore --list, no DB connection needed) ..."
pg_restore --list "$PLAIN_DUMP" | head -20
echo "..."
echo "($(pg_restore --list "$PLAIN_DUMP" | wc -l) total TOC entries)"

echo ""
echo "About to restore into: $TARGET_DB_URL"
read -r -p "Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

echo "Restoring ..."
pg_restore -d "$TARGET_DB_URL" --no-owner --no-privileges "$PLAIN_DUMP"

echo ""
echo "Restore complete. Sanity-check row counts against the target:"
echo "  psql \"$TARGET_DB_URL\" -c \"select 'companies', count(*) from companies union all select 'employees', count(*) from employees union all select 'jobs', count(*) from jobs;\""
