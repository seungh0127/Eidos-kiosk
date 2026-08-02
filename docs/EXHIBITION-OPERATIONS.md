# Exhibition operations

## Start

Double-click `start-eidos.command`. It builds the app, checks the local runtime and all 18 media pairs, starts the API on `127.0.0.1:3000`, and opens Chrome with a dedicated kiosk profile.

On the first run, allow Chrome to use the camera and microphone. The camera feed is processed locally by MediaPipe; frames and face boxes are not stored. Audio is sent to the Realtime transcription session and is not stored by Eidos.

## Operator panel

- `Ctrl+Option+E`: open or close the hidden diagnostics panel.
- `Ctrl+Option+R`: force the current visitor back to the idle state.
- During development, `VITE_EIDOS_DEBUG=true` keeps the panel visible. It shows the live camera preview with the tracked face box, face count/confidence/area/stability, microphone input level, Realtime connection, raw and completed transcription, explicit `HI EIDOS DETECTED` state, event logs, recent session metadata, and log export.
- The panel has quick buttons for pausing/resuming/checking the microphone and checking/resetting the `Soma` counter. Counter reset requires a second confirmation click within five seconds and does not delete session logs.
- Set `VITE_EIDOS_DEBUG=false` for the final presentation layout; `Ctrl+Option+E` still opens the panel when needed.
- `?mock&gallery` opens the design handoff gallery without camera or API access.

The counter increases only after a valid analysis result is written. Reset, timeout, API failure and preview sessions do not increase it. Session metadata is pruned after 30 days.

## Recovery

1. Press `Ctrl+Option+R` once.
2. If the panel reports missing media, run `npm run media:validate`; do not copy source MOV files into `apps/web/public`.
3. If the API is unavailable, inspect `data/server.log` and restart `start-eidos.command`.
4. If camera or microphone access was denied, open Chrome site settings for `127.0.0.1` and allow both devices, then restart Chrome.
5. If the kiosk profile is corrupted, close Chrome and remove only `data/chrome-profile`, then relaunch. The SQLite counter is stored separately in `data/eidos.sqlite`.
