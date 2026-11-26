#!/usr/bin/env bash
# Generates the two HMAC secrets, writes them to .env.n8n (for the n8n container) and
# sets the same values on the current Convex deployment. Never prints the secrets.
#
#   scripts/setup-secrets.sh                      # webhook URL defaults to local n8n
#   N8N_REQUEST_WEBHOOK_URL=https://n8n.example.com/webhook/lendloop-request scripts/setup-secrets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

convex=./node_modules/.bin/convex
[ -x "$convex" ] || { echo "Run npm install first." >&2; exit 1; }

if [ -f .env.n8n ]; then
  echo ".env.n8n already exists; reusing its secrets."
else
  umask 077
  sed -e "s/^N8N_WEBHOOK_SECRET=.*/N8N_WEBHOOK_SECRET=$(openssl rand -hex 32)/" \
      -e "s/^LENDLOOP_API_SECRET=.*/LENDLOOP_API_SECRET=$(openssl rand -hex 32)/" \
      .env.n8n.example > .env.n8n
  echo "Wrote .env.n8n with new secrets."
fi

set -a; . ./.env.n8n; set +a
webhook_url="${N8N_REQUEST_WEBHOOK_URL:-http://localhost:5678/webhook/lendloop-request}"

"$convex" env set N8N_WEBHOOK_SECRET "$N8N_WEBHOOK_SECRET" >/dev/null
"$convex" env set LENDLOOP_API_SECRET "$LENDLOOP_API_SECRET" >/dev/null
"$convex" env set N8N_REQUEST_WEBHOOK_URL "$webhook_url" >/dev/null
echo "Set N8N_WEBHOOK_SECRET, LENDLOOP_API_SECRET and N8N_REQUEST_WEBHOOK_URL=$webhook_url on Convex."
