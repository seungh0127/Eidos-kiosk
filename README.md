# Eidos Kiosk

Eidos is a local exhibition kiosk that detects a visitor, listens for “Hi, Eidos”, transcribes a Korean or English request, selects one of 18 robot presets, and presents a generated English title and task list.

## Requirements

- macOS with Node.js 22 or newer
- Google Chrome for kiosk mode
- FFmpeg for robot media conversion
- An OpenAI API key for live mode

## Local setup

```bash
npm install
cp .env.example .env
# Add OPENAI_API_KEY to .env
npm run dev
```

The Vite UI is available at `http://localhost:5173`; the local API runs at `http://127.0.0.1:3000`.

For a browser-only designer flow without a camera or API key:

```bash
EIDOS_MOCK=true npm run start --workspace @eidos/server
open 'http://127.0.0.1:3000?mock'
```

## Media

Place the source robot ZIP archives in the project root. The importer expects `Robot/<id>.mov` for every ID from 1 to 18.

```bash
npm run media:validate
npm run media:convert
```

The source files are ProRes MOV assets and are not used directly by Chrome. The conversion script creates silent VP9 WebM files with alpha and WebP posters under `apps/web/public/media`.

## Kiosk mode

Copy `.env.example` to `.env`, configure the key, and double-click `start-eidos.command`. The launcher builds the app, starts the local server, verifies the runtime endpoint, and opens a dedicated Chrome profile in kiosk mode. The first run requires camera and microphone permissions.

## Architecture

- `apps/web`: React/Vite UI, state machine, local MediaPipe face presence, WebRTC transcription client, Mock mode
- `apps/server`: Express API, short-lived OpenAI Realtime client-secret issuer, Responses API routing, SQLite persistence, operator endpoints
- `packages/shared`: shared phases, result contracts, and runtime status types
- `data/eidos.sqlite`: local counter and 30-day session metadata; never commit this directory

The browser never receives the permanent OpenAI API key. The server creates a short-lived Realtime client secret through `/v1/realtime/client_secrets`, configured with `gpt-realtime-2.1-mini`, `gpt-live-transcribe`, and `semantic_vad · medium`; the browser uses that secret only in memory to post its SDP offer to `/v1/realtime/calls`.

## Handoff and operations

- [Project handoff: operation, architecture, routing and hidden controls](docs/PROJECT-HANDOFF.md)
- [Installation](docs/INSTALLATION.md)
- [Exhibition operations and recovery](docs/EXHIBITION-OPERATIONS.md)
- [Frontend handoff](docs/FRONTEND-HANDOFF.md)
- [Security and privacy](docs/SECURITY.md)

## Operator controls

- `Ctrl+Option+E`: toggle the diagnostic panel
- `Ctrl+Option+R`: force reset

The operator panel is hidden from the final exhibition UI. Mock mode exposes request controls for frontend and routing tests.

For the current development pass, set `VITE_EIDOS_DEBUG=true` in `.env` to keep the monitor visible. It exposes the camera preview, tracked face telemetry, microphone level, Realtime status, transcript, wakeword confirmation, and event log. Set it to `false` for the final presentation layout.
