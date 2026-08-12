#!/bin/zsh
set -euo pipefail

# Finder로 이 파일을 실행하면 ~/.zshrc가 읽히지 않아 nvm이 활성화되지
# 않을 수 있습니다. Vite와 Eidos 서버가 사용할 수 있는 Node.js를 먼저
# 선택한 뒤, 조건을 만족하지 못하면 서버를 시작하지 않고 안내합니다.
node_supported() {
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' >/dev/null 2>&1
}

if ! node_supported; then
  EIDOS_NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$EIDOS_NVM_DIR/nvm.sh" ]]; then
    source "$EIDOS_NVM_DIR/nvm.sh"
    for EIDOS_NODE_VERSION in 24 22; do
      if nvm use "$EIDOS_NODE_VERSION" >/dev/null 2>&1 && node_supported; then
        break
      fi
    done
  fi
fi

if ! node_supported; then
  EIDOS_CURRENT_NODE="$(node --version 2>/dev/null || echo 'not installed')"
  echo "Eidos requires Node.js 22.12 or newer. Found $EIDOS_CURRENT_NODE."
  echo "Install and select a version, then run this file again:"
  echo "  nvm install 24"
  echo "  nvm use 24"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# The QR code contains a short redirect served by this Mac. Listen on the
# local network so a visitor's phone on the same Wi-Fi can open it; Chrome
# still opens the kiosk through 127.0.0.1 below.
export HOST="${EIDOS_SERVER_HOST:-0.0.0.0}"

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
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  if curl -fsS http://127.0.0.1:3000/api/runtime >/dev/null 2>&1; then break; fi
  sleep 1
done

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "Eidos server process exited. See data/server.log."
  exit 1
fi

if ! curl -fsS http://127.0.0.1:3000/api/runtime >/dev/null 2>&1; then
  echo "Eidos server did not start. See data/server.log."
  exit 1
fi

if ! curl -fsS http://127.0.0.1:3000/ >/dev/null 2>&1; then
  echo "Eidos server is responding, but the web app is unavailable at /."
  echo "Stop any older server using port 3000, then run this file again."
  exit 1
fi

node scripts/check-runtime.mjs

open -na "Google Chrome" --args --kiosk --user-data-dir="$PROJECT_DIR/data/chrome-profile" http://127.0.0.1:3000
wait "$SERVER_PID"
