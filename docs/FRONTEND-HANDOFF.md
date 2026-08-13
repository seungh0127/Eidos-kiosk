# Frontend handoff

전체 운영·알고리즘·히든 코드·인수인계 기준은 [PROJECT-HANDOFF.md](./PROJECT-HANDOFF.md)를 먼저 읽는다. 이 문서는 프론트 구현자가 화면을 교체할 때 필요한 계약만 요약한다.

The front end is intentionally separated into behavior and presentation:

- `apps/web/src/App.tsx` owns the explicit kiosk phases and transitions.
- `apps/web/src/presence.tsx` owns camera permission, local face detection and visitor presence.
- `apps/web/src/realtime.ts` owns the browser WebRTC transcription connection.
- The server creates one general Realtime session using `gpt-realtime-2.1-mini` as the semantic turn detector and `gpt-live-transcribe` as its input transcription model. `semantic_vad · medium` is active from the start, including wake-listen. The browser uses transcript deltas for exact wakeword detection, then waits for `speech_stopped` and the matching completed transcript before sending the request to Luna. There is no dynamic post-wake `session.update` and no silent Local VAD fallback; if Semantic VAD is not enabled, the connection fails visibly so the operator can diagnose the provider/session configuration.
- `apps/web/src/styles.css` contains presentation tokens, layout and motion; replace these styles without changing the state or API contracts.
- The development monitor is rendered from `DiagnosticPanel` in `apps/web/src/App.tsx`; it is intentionally diagnostic rather than presentation-polished. It consumes telemetry from `presence.tsx` and the microphone level callback from `realtime.ts`. `Ctrl+Option+E` toggles it, and the panel command input supports `/mic pause`, `/mic resume`, and `/mic status`.
- `?mock` removes the camera and Realtime dependency. The Mock panel can drive the request flow, while `?mock&gallery` previews all phases and all 18 result assets.

The public analysis contract is defined in `packages/shared/src/index.ts`:

```ts
type AnalysisResult = {
  sessionId: string;
  robotId: number;
  displayName: string;
  title: string;
  requiredTasks: string[];
  matchedRule: string;
  videoUrl: string;
};
```

The design layer should keep result video playback muted, looped and `playsInline`. Robot media is silent by design. The analyzing screen uses a keyed three-card vertical stack: the center card plays the selected robot's WebM while the cards above and below use WebP posters. Cards move every about 760ms, the selected card settles for about 650ms, and the total transition is about 3 seconds. Keep the keyed card identity and the non-overlapping portrait layout when redesigning this component.

## API handoff

- `POST /api/realtime/session`: returns a short-lived Realtime client secret configured with `gpt-realtime-2.1-mini`, `gpt-live-transcribe`, and `semantic_vad · medium`; the permanent key never enters the browser. The browser uses that secret in memory for the SDP request to OpenAI.
- `POST /api/analyze`: `{ sessionId, transcript, startedAt }` in, `AnalysisResult` out.
- `GET /api/runtime`: counter, asset readiness and model configuration.
- `GET /api/operator/status`: local diagnostics.
- `GET /api/operator/sessions`: recent metadata for the panel/export.
- `POST /api/photo`: accepts a browser-created `image/jpeg` body up to 3 MB and returns `{ downloadUrl, expiresAt, size }`. The browser first encodes the card at 1080px with high JPEG quality, then retries with small quality and resolution reductions only when the image exceeds the upload target. The URL is a temporary signed R2 GET URL and is the only value that should be encoded into the QR. When R2 is not configured the endpoint returns 503; keep that state visible to the operator.

The result photo flow is `greeting → photo-onboarding → photo-capture →
photo-countdown → photo-uploading → photo-ready/photo-error`. MediaPipe
`GestureRecognizer` reports `Closed_Fist`; a score of at least `.65` held for
approximately `.18s` arms the gesture. The capture callback fires only when
the visitor opens the hand again within `1.5s`, so holding a fist by itself no
longer takes a photo. The UI then holds the visitor in a visible three-second
`3 · 2 · 1` countdown before the actual capture and shows a short screen flash
at the capture moment. Opening the hand during the countdown does not cancel
the already-confirmed shot. The browser captures the actual
result-card back-face DOM with `html-to-image`. The initial output is 1080px
wide and is adaptively recompressed below the 3 MB upload limit when needed.
Before capture, each live video
is replaced in the temporary clone by a current canvas frame, preserving the
camera mirror, robot alpha frame, card header, and per-robot offset without
capturing the 3D flip transform. Keep the photo preview/QR screen long enough
to scan and let the parent reset the visitor after its timer. The operator log
reports the encoded JPEG size before upload and the server-accepted byte size;
an unexpectedly tiny value indicates a capture failure before R2 is involved.

The final deployment target is the exhibition Mac's local Node server. Keep the local `.env` for live demonstrations, but never commit it. Do not move `OPENAI_API_KEY` into Vite variables or a client bundle.
