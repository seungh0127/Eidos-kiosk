#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

if [[ ! -d node_modules ]]; then
  npm install
fi

if [[ "${EIDOS_MOCK:-false}" != "true" && ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env and add OPENAI_API_KEY."
  exit 1
fi

npm run build

mkdir -p data
node apps/server/dist/server.js > data/server.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/api/runtime >/dev/null 2>&1; then break; fi
  sleep 1
done

if ! curl -fsS http://127.0.0.1:3000/api/runtime >/dev/null 2>&1; then
  echo "Eidos server did not start. See data/server.log."
  exit 1
fi

node scripts/check-runtime.mjs

open -na "Google Chrome" --args --kiosk --user-data-dir="$PROJECT_DIR/data/chrome-profile" http://127.0.0.1:3000
wait "$SERVER_PID"
