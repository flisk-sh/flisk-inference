#!/usr/bin/env bash
# Fails if a tracked file looks like it holds a credential. Run in CI, and before publishing.
set -euo pipefail
PATTERN='ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|GITHUB_CLIENT_SECRET=[0-9a-f]{20,}|fi-[A-Za-z0-9_-]{30,}'
if git grep -n -I -E "$PATTERN" -- . ':!scripts/check-secrets.sh' ':!services/app/web/tests'; then
  echo "A file looks like it contains a credential." >&2; exit 1
fi
echo "no credential-looking strings in tracked files"
