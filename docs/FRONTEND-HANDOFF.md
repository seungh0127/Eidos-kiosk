# Frontend handoff

전체 운영·알고리즘·히든 코드·인수인계 기준은 [PROJECT-HANDOFF.md](./PROJECT-HANDOFF.md)를 먼저 읽는다. 이 문서는 프론트 구현자가 화면을 교체할 때 필요한 계약만 요약한다.

The front end is intentionally separated into behavior and presentation:

- `apps/web/src/App.tsx` owns the explicit kiosk phases and transitions.
- `apps/web/src/presence.tsx` owns camera permission, local face detection and visitor presence.
- `apps/web/src/realtime.ts` owns the browser WebRTC transcription connection.
- The server Realtime transcription session uses `semantic_vad` with `eagerness: "medium"` as the primary turn detector. `realtime.ts` listens for `input_audio_buffer.speech_started` / `speech_stopped`; the browser's amplitude VAD remains telemetry and a maximum-duration safety commit only.
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

- `POST /api/realtime/session`: returns a short-lived Realtime client secret; the permanent key never enters the browser. The browser uses that secret in memory for the SDP request to OpenAI.
- `POST /api/analyze`: `{ sessionId, transcript, startedAt }` in, `AnalysisResult` out.
- `GET /api/runtime`: counter, asset readiness and model configuration.
- `GET /api/operator/status`: local diagnostics.
- `GET /api/operator/sessions`: recent metadata for the panel/export.

The final deployment target is the exhibition Mac's local Node server. Keep the local `.env` for live demonstrations, but never commit it. Do not move `OPENAI_API_KEY` into Vite variables or a client bundle.
