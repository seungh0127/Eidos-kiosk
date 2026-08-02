# Installation

## Prerequisites

- macOS, Node.js 22+, npm, Google Chrome
- FFmpeg 8+ when converting the source archives
- Git LFS before publishing the repository with runtime media

## First setup

```bash
npm install
cp .env.example .env
npm run media:validate
npm run media:convert
npm run typecheck
npm run test:unit
npm run build
```

Add `OPENAI_API_KEY` to `.env` for exhibition mode. The file is intentionally ignored by Git. The default server binding is `127.0.0.1`; change `HOST` only for a deliberate local-network setup.

The two source ZIP files stay outside Git. `npm run media:validate` requires exactly one `Robot/<id>.mov` for every ID 1–18 and `npm run media:convert` produces silent VP9 WebM alpha video plus WebP posters.

## Development

```bash
npm run dev
open 'http://127.0.0.1:5173/?mock'
```

### Portrait testing with DevTools

`start-eidos.command` and `npm run kiosk` intentionally launch Chrome with `--kiosk`, so use a separate normal Chrome profile while tuning the UI:

```bash
npm run dev
EIDOS_DEV_PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/eidos-chrome.XXXXXX")"
open -na "Google Chrome" --args --user-data-dir="$EIDOS_DEV_PROFILE" --auto-open-devtools-for-tabs 'http://127.0.0.1:5173/?debug'
```

In DevTools, press `⌘⇧M` to open Device Toolbar and set a custom portrait viewport such as `1080 × 1920`. Use `?mock&debug` when you want to inspect the UI without camera, microphone, or API access.

For the production-shaped local flow:

```bash
EIDOS_MOCK=true npm run build
EIDOS_MOCK=true npm run start --workspace @eidos/server
open 'http://127.0.0.1:3000/?mock'
```

Use `http://127.0.0.1:3000/?mock&gallery` for the state and robot asset gallery.
