export type RealtimeCallbacks = {
  onDelta: (delta: string) => void;
  onCompleted: (transcript: string) => void;
  onStatus?: (status: "preparing" | "connecting" | "connected" | "closed" | "error", detail?: string) => void;
  onAudioLevel?: (level: number) => void;
};

export type RealtimeStop = (() => void) & {
  pause: () => void;
  resume: () => void;
};

export class RealtimeConnectionCancelledError extends Error {
  constructor() {
    super("Realtime connection attempt cancelled.");
    this.name = "RealtimeConnectionCancelledError";
  }
}

type RealtimeOptions = { signal?: AbortSignal };

// These are deliberately conservative starting values for the exhibition mic.
// They can be tuned later using the operator panel's input-level telemetry.
const LOCAL_SPEECH_THRESHOLD = 0.08;
const LOCAL_START_MS = 220;
const LOCAL_SILENCE_MS = 1000;
const LOCAL_MIN_SPEECH_MS = 260;
const LOCAL_NOISE_CALIBRATION_MS = 700;
const LOCAL_NOISE_MARGIN = 0.035;
// Safety net: the noise floor is calibrated once, briefly, right when the
// connection opens. If real exhibition-hall ambient noise later runs higher
// than that snapshot, the level can stay above the speech threshold through
// what the visitor experiences as silence, so LOCAL_SILENCE_MS's turn-end
// detection never fires and the request never finalizes — this was likely
// the "finished talking but nothing happens" bug. Forcing a commit once a
// turn has been open this long guarantees it can never hang indefinitely,
// independent of whatever the noise floor actually is.
const LOCAL_MAX_SPEECH_MS = 6000;
const REALTIME_READY_TIMEOUT_MS = 15_000;

async function formatSessionError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(body) as {
        error?: string | { message?: string };
        code?: string;
        upstreamStatus?: number;
        elapsedMs?: number;
        requestId?: string;
      };
      const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
      const upstream = payload.upstreamStatus ? `upstream ${payload.upstreamStatus}` : `HTTP ${response.status}`;
      const elapsed = payload.elapsedMs ? ` · ${payload.elapsedMs}ms` : "";
      const requestId = payload.requestId ? ` · request ${payload.requestId}` : "";
      return `${message ?? "Realtime session request failed."} (${upstream}${payload.code ? `, ${payload.code}` : ""}${elapsed})${requestId}`;
    } catch {
      // Fall through to the short status message. Never render an HTML error page.
    }
  }
  return `Realtime session request failed (HTTP ${response.status})`;
}

export async function startRealtimeTranscription(callbacks: RealtimeCallbacks, options: RealtimeOptions = {}): Promise<RealtimeStop> {
  const { signal } = options;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("이 브라우저에서 마이크를 사용할 수 없습니다.");
  }
  if (signal?.aborted) throw new RealtimeConnectionCancelledError();

  callbacks.onStatus?.("preparing");
  const peer = new RTCPeerConnection();
  const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  if (signal?.aborted) {
    peer.close();
    audioStream.getTracks().forEach((track) => track.stop());
    throw new RealtimeConnectionCancelledError();
  }

  const dataChannel = peer.createDataChannel("oai-events");
  let closed = false;
  let audioContext: AudioContext | undefined;
  let audioMeterFrame = 0;
  let dataChannelReady = false;
  let speechActive = false;
  let speechStartedAt = 0;
  let speechCandidateSince = 0;
  let lastVoiceAt = 0;
  let paused = false;
  let vadReady = false;
  let closeReported = false;
  let readySettled = false;
  let readyTimer: number | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // If signaling fails before we await readiness, this prevents a rejected
  // readiness promise from becoming an unhandled rejection.
  void readyPromise.catch(() => undefined);

  const settleReadyError = (error: Error) => {
    if (readySettled) return;
    readySettled = true;
    if (readyTimer !== null) window.clearTimeout(readyTimer);
    rejectReady(error);
  };

  const reportClosed = () => {
    if (closeReported) return;
    closeReported = true;
    callbacks.onStatus?.("closed");
  };

  const resolveReadyIfPossible = () => {
    if (readySettled || !dataChannelReady || !vadReady) return;
    readySettled = true;
    if (readyTimer !== null) window.clearTimeout(readyTimer);
    resolveReady();
  };

  let stop: RealtimeStop = Object.assign(() => undefined, {
    pause: () => undefined,
    resume: () => undefined,
  });
  const abortHandler = () => stop();

  const commitTurn = (timestamp: number) => {
    if (!speechActive || !dataChannelReady || dataChannel.readyState !== "open") return;
    if (!speechStartedAt || timestamp - speechStartedAt < LOCAL_MIN_SPEECH_MS) {
      speechActive = false;
      speechStartedAt = 0;
      speechCandidateSince = 0;
      lastVoiceAt = 0;
      return;
    }
    dataChannel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    speechActive = false;
    speechStartedAt = 0;
    speechCandidateSince = 0;
    lastVoiceAt = timestamp;
    callbacks.onStatus?.("connected", "Local VAD: turn committed");
  };

  const setPaused = (nextPaused: boolean) => {
    if (closed || paused === nextPaused) return;
    paused = nextPaused;
    speechActive = false;
    speechStartedAt = 0;
    speechCandidateSince = 0;
    lastVoiceAt = 0;
    audioStream.getAudioTracks().forEach((track) => { track.enabled = !nextPaused; });
    callbacks.onAudioLevel?.(0);
    callbacks.onStatus?.("connected", nextPaused ? "Microphone paused by operator" : "Microphone resumed");
  };

  stop = Object.assign(() => {
    if (closed) return;
    closed = true;
    dataChannelReady = false;
    paused = false;
    speechActive = false;
    speechStartedAt = 0;
    speechCandidateSince = 0;
    lastVoiceAt = 0;
    dataChannel.close();
    peer.close();
    audioStream.getTracks().forEach((track) => track.stop());
    if (audioMeterFrame) cancelAnimationFrame(audioMeterFrame);
    void audioContext?.close();
    if (readyTimer !== null) window.clearTimeout(readyTimer);
    signal?.removeEventListener("abort", abortHandler);
    if (!readySettled) settleReadyError(new RealtimeConnectionCancelledError());
    reportClosed();
  }, { pause: () => setPaused(true), resume: () => setPaused(false) });

  signal?.addEventListener("abort", abortHandler, { once: true });
  audioStream.getTracks().forEach((track) => peer.addTrack(track, audioStream));
  callbacks.onStatus?.("preparing", `Microphone ready (${audioStream.getAudioTracks()[0]?.readyState ?? "unknown"})`);

  try {
    audioContext = new AudioContext();
    await audioContext.resume();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    const source = audioContext.createMediaStreamSource(audioStream);
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let lastReport = 0;
    const calibrationStartedAt = performance.now();
    let calibrationSum = 0;
    let calibrationCount = 0;
    let noiseFloor = 0;
    let noiseCalibrated = false;

    const meter = (timestamp: number) => {
      if (closed) return;
      if (paused) {
        if (timestamp - lastReport >= 100) {
          callbacks.onAudioLevel?.(0);
          lastReport = timestamp;
        }
        audioMeterFrame = requestAnimationFrame(meter);
        return;
      }
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;

      if (timestamp - lastReport >= 100) {
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
        callbacks.onAudioLevel?.(level);

        if (!noiseCalibrated) {
          calibrationSum += level;
          calibrationCount += 1;
          if (timestamp - calibrationStartedAt >= LOCAL_NOISE_CALIBRATION_MS) {
            noiseFloor = calibrationCount ? calibrationSum / calibrationCount : 0;
            noiseCalibrated = true;
            vadReady = true;
            callbacks.onStatus?.("connected", `Local VAD ready · noise floor ${noiseFloor.toFixed(3)}`);
            resolveReadyIfPossible();
          }
        }

        if (dataChannelReady) {
          const threshold = Math.max(LOCAL_SPEECH_THRESHOLD, noiseFloor * 1.8 + LOCAL_NOISE_MARGIN);
          if (level >= threshold) {
            if (!speechCandidateSince) speechCandidateSince = timestamp;
            if (!speechActive && timestamp - speechCandidateSince >= LOCAL_START_MS) {
              speechActive = true;
              speechStartedAt = speechCandidateSince;
              callbacks.onStatus?.("connected", "Local VAD: speech detected");
            }
            // Same LOCAL_START_MS debounce applies to *resuming* voice, not
            // just starting it — otherwise a single stray noisy sample
            // (100ms) during the silence countdown below resets it back to
            // zero, and real ambient noise can keep doing that indefinitely,
            // so the turn never ends on its own. Only a sustained re-entry
            // counts as "still talking".
            if (speechActive && timestamp - speechCandidateSince >= LOCAL_START_MS) lastVoiceAt = timestamp;
          } else {
            speechCandidateSince = 0;
            if (speechActive && timestamp - lastVoiceAt >= LOCAL_SILENCE_MS) commitTurn(timestamp);
          }
          // Silence-based end-of-turn detection depends on ambient noise
          // staying close to the one-time calibration snapshot. If it
          // doesn't, this forces the turn closed anyway instead of holding
          // the buffer open indefinitely.
          if (speechActive && speechStartedAt && timestamp - speechStartedAt >= LOCAL_MAX_SPEECH_MS) {
            callbacks.onStatus?.("connected", "Local VAD: max speech length reached, forcing turn end");
            commitTurn(timestamp);
          }
        } else {
          speechActive = false;
          speechStartedAt = 0;
          speechCandidateSince = 0;
          lastVoiceAt = 0;
        }
        lastReport = timestamp;
      }
      audioMeterFrame = requestAnimationFrame(meter);
    };
    audioMeterFrame = requestAnimationFrame(meter);
  } catch {
    vadReady = true;
    callbacks.onStatus?.("preparing", "Microphone level meter unavailable");
    resolveReadyIfPossible();
  }

  dataChannel.addEventListener("open", () => {
    dataChannelReady = true;
    speechActive = false;
    speechStartedAt = 0;
    speechCandidateSince = 0;
    lastVoiceAt = 0;
    callbacks.onStatus?.("connected", "Transcription session ready");
    resolveReadyIfPossible();
  });
  dataChannel.addEventListener("close", () => {
    dataChannelReady = false;
    if (!readySettled) settleReadyError(new Error("Realtime data channel closed before ready."));
    reportClosed();
  });
  dataChannel.addEventListener("error", () => callbacks.onStatus?.("error", "Realtime data channel error"));
  dataChannel.addEventListener("message", (message) => {
    try {
      const event = JSON.parse(message.data as string) as { type?: string; delta?: string; transcript?: string };
      if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
        callbacks.onDelta(event.delta);
      }
      if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
        callbacks.onStatus?.("connected", "Transcription completed");
        callbacks.onCompleted(event.transcript);
      }
      if (event.type === "error") {
        callbacks.onStatus?.("error", "Realtime transcription error");
      }
    } catch {
      callbacks.onStatus?.("error", "Invalid realtime event");
    }
  });

  try {
    callbacks.onStatus?.("connecting", "Connecting transcription session");
    const tokenResponse = await fetch("/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    });
    if (!tokenResponse.ok) throw new Error(await formatSessionError(tokenResponse));
    const tokenPayload = await tokenResponse.json() as { clientSecret?: string };
    if (!tokenPayload.clientSecret) throw new Error("Realtime session did not return a client secret.");
    if (signal?.aborted) throw new RealtimeConnectionCancelledError();

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${tokenPayload.clientSecret}`,
        "Content-Type": "application/sdp",
      },
      signal,
    });
    if (!response.ok) throw new Error(await formatSessionError(response));
    const answerSdp = await response.text();
    if (signal?.aborted) throw new RealtimeConnectionCancelledError();
    await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    if (!readySettled) {
      readyTimer = window.setTimeout(() => {
        settleReadyError(new Error("Realtime data channel did not become ready."));
        stop();
      }, REALTIME_READY_TIMEOUT_MS);
    }
    await readyPromise;
    return stop;
  } catch (error) {
    stop();
    if (signal?.aborted || error instanceof RealtimeConnectionCancelledError || (error instanceof DOMException && error.name === "AbortError")) {
      throw new RealtimeConnectionCancelledError();
    }
    callbacks.onStatus?.("error", error instanceof Error ? error.message : "Realtime connection failed");
    throw error;
  }
}
