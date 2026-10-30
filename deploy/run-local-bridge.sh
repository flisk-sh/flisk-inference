#!/usr/bin/env bash
# Serves this portal on a machine that already has Ollama and a Cloudflare tunnel pointing at localhost:$PORT.
# A stop-gap until the service runs on a server (see DEPLOY.md). Settings come from ENV_FILE (never committed).
#   ENV_FILE=/path/to/oauth.env DATA_DIR=/path/to/data ./deploy/run-local-bridge.sh
set -euo pipefail
cd "$(dirname "$0")/../services/app/web"
: "${ENV_FILE:?set ENV_FILE to a file with GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET}"
: "${DATA_DIR:?set DATA_DIR to the folder holding db.json and secret}"
set -a; source "$ENV_FILE"; set +a
export PORT="${PORT:-8765}" PUBLIC_URL="${PUBLIC_URL:-https://inference.flisk.si}" UPSTREAM_URL="${UPSTREAM_URL:-http://127.0.0.1:11434}" \
  ALLOWED_MODELS="${ALLOWED_MODELS:-flisk-wolf}" ALLOWED_LOGINS="${ALLOWED_LOGINS:-odykyi}" PORTAL_NAME="${PORTAL_NAME:-Flisk Inference}" DATA_DIR
unset FLISK_DEV_LOGIN
exec bun src/index.ts
