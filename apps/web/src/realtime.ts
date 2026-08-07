export type RealtimeCallbacks = {
  onDelta: (delta: string) => void;
  onCompleted: (transcript: string) => void;
  onStatus?: (status: "preparing" | "connecting" | "connected" | "closed" | "error", detail?: string) => void;
  onAudioLevel?: (level: number) => void;
  onVad?: (snapshot: VadSnapshot) => void;
  onTurnDetection?: (mode: "semantic_vad" | "local_vad") => void;
};

export type RealtimeVadConfig = {
  speechThreshold?: number;
  noiseMultiplier?: number;
  noiseMargin?: number;
  startMs?: number;
  minSpeechMs?: number;
  silenceMs?: number;
  maxSpeechMs?: number;
};

export type VadSnapshot = {
  level: number;
  noiseFloor: number;
  threshold: number;
  speechActive: boolean;
  calibrated: boolean;
  lastCommitAt: number | null;
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

type RealtimeOptions = { signal?: AbortSignal; vad?: RealtimeVadConfig };
type TurnDetectionMode = "semantic_vad" | "local_vad";

// These are deliberately conservative starting values for the exhibition mic.
// They can be tuned later using the operator panel's input-level telemetry.
const LOCAL_SPEECH_THRESHOLD = 0.08;
const LOCAL_START_MS = 220;
const LOCAL_MIN_SPEECH_MS = 260;
const LOCAL_SILENCE_MS = 1000;
const LOCAL_NOISE_CALIBRATION_MS = 700;
const LOCAL_NOISE_MARGIN = 0.035;
// Safety net: an unusually long local turn is committed even if a noisy room
// keeps the amplitude above threshold. This guarantees the kiosk cannot hang
// indefinitely waiting for a quiet interval.
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

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index] ?? 0;
}

export async function startRealtimeTranscription(callbacks: RealtimeCallbacks, options: RealtimeOptions = {}): Promise<RealtimeStop> {
  const { signal } = options;
  const vad = {
    speechThreshold: LOCAL_SPEECH_THRESHOLD,
    noiseMultiplier: 1.8,
    noiseMargin: LOCAL_NOISE_MARGIN,
    startMs: LOCAL_START_MS,
    minSpeechMs: LOCAL_MIN_SPEECH_MS,
    silenceMs: LOCAL_SILENCE_MS,
    maxSpeechMs: LOCAL_MAX_SPEECH_MS,
    ...options.vad,
  };
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("이 브라우저에서 마이크를 사용할 수 없습니다.");
  }
  if (signal?.aborted) throw new RealtimeConnectionCancelledError();

  callbacks.onStatus?.("preparing");
  const peer = new RTCPeerConnection();
  const audioStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: { ideal: 1 },
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      // AGC can amplify a distant side conversation during a quiet interval.
      // Keep it off and let the visitor's mic level remain stable instead.
      autoGainControl: { ideal: false },
    },
  });
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
  let semanticSpeechActive = false;
  let semanticSpeechStartedAt = 0;
  let turnDetectionMode: TurnDetectionMode = "local_vad";
  let paused = false;
  let noiseFloor = 0;
  let noiseCalibrated = false;
  let vadReady = false;
  let lastCommitAt: number | null = null;
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

  // Keep the wake-listen prompt behind the short noise-floor calibration.
  // This is the pre-speed-up behavior: the prompt appears only after both
  // the data channel and the local microphone baseline are ready.
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

  // Local VAD is the compatibility path used when the provider rejects
  // semantic turn detection for the current transcription model.
  const commitTurn = (timestamp: number) => {
    if (turnDetectionMode !== "local_vad" || !speechActive || !dataChannelReady || dataChannel.readyState !== "open") return;
    const startedAt = speechStartedAt;
    if (!startedAt || timestamp - startedAt < vad.minSpeechMs) {
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
    lastCommitAt = timestamp;
    callbacks.onVad?.({
      level: 0,
      noiseFloor,
      threshold: Math.max(vad.speechThreshold, noiseFloor * vad.noiseMultiplier + vad.noiseMargin),
      speechActive: false,
      calibrated: noiseCalibrated,
      lastCommitAt,
    });
    callbacks.onStatus?.("connected", "Local VAD: turn committed");
  };

  const commitSemanticSafetyTurn = (timestamp: number) => {
    if (turnDetectionMode !== "semantic_vad" || !semanticSpeechActive || !dataChannelReady || dataChannel.readyState !== "open") return;
    const startedAt = semanticSpeechStartedAt;
    if (!startedAt || timestamp - startedAt < vad.minSpeechMs) return;
    dataChannel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    semanticSpeechActive = false;
    semanticSpeechStartedAt = 0;
    lastCommitAt = timestamp;
    callbacks.onVad?.({
      level: 0,
      noiseFloor,
      threshold: Math.max(vad.speechThreshold, noiseFloor * vad.noiseMultiplier + vad.noiseMargin),
      speechActive: false,
      calibrated: noiseCalibrated,
      lastCommitAt,
    });
    callbacks.onStatus?.("connected", "Semantic VAD safety commit");
  };

  const setPaused = (nextPaused: boolean) => {
    if (closed || paused === nextPaused) return;
    paused = nextPaused;
    speechActive = false;
    speechStartedAt = 0;
    speechCandidateSince = 0;
    lastVoiceAt = 0;
    semanticSpeechActive = false;
    semanticSpeechStartedAt = 0;
    audioStream.getAudioTracks().forEach((track) => { track.enabled = !nextPaused; });
    callbacks.onAudioLevel?.(0);
    callbacks.onVad?.({
      level: 0,
      noiseFloor,
      threshold: Math.max(vad.speechThreshold, noiseFloor * vad.noiseMultiplier + vad.noiseMargin),
      speechActive: false,
      calibrated: noiseCalibrated,
      lastCommitAt,
    });
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
    semanticSpeechActive = false;
    semanticSpeechStartedAt = 0;
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
  const audioTrack = audioStream.getAudioTracks()[0];
  const audioSettings = audioTrack?.getSettings();
  callbacks.onStatus?.("preparing", `Microphone ready (${audioTrack?.readyState ?? "unknown"}) · NS ${audioSettings?.noiseSuppression === false ? "off" : "on"} · EC ${audioSettings?.echoCancellation === false ? "off" : "on"} · AGC ${audioSettings?.autoGainControl === true ? "on" : "off"}`);

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
    const calibrationLevels: number[] = [];

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
          calibrationLevels.push(level);
          if (timestamp - calibrationStartedAt >= LOCAL_NOISE_CALIBRATION_MS) {
            // Use a high percentile so intermittent hall noise contributes to
            // the threshold instead of disappearing into a quiet average.
            noiseFloor = percentile(calibrationLevels, 0.9);
            noiseCalibrated = true;
            vadReady = true;
            callbacks.onStatus?.("connected", `Local VAD ready · noise floor ${noiseFloor.toFixed(3)}`);
            resolveReadyIfPossible();
          }
        }

        const threshold = Math.max(vad.speechThreshold, noiseFloor * vad.noiseMultiplier + vad.noiseMargin);
        callbacks.onVad?.({ level, noiseFloor, threshold, speechActive: turnDetectionMode === "semantic_vad" ? semanticSpeechActive : speechActive, calibrated: noiseCalibrated, lastCommitAt });

        if (dataChannelReady && turnDetectionMode === "local_vad") {
          if (level >= threshold) {
            if (!speechCandidateSince) speechCandidateSince = timestamp;
            if (!speechActive && timestamp - speechCandidateSince >= vad.startMs) {
              speechActive = true;
              speechStartedAt = speechCandidateSince;
              lastVoiceAt = timestamp;
              callbacks.onStatus?.("connected", "Local VAD: speech detected");
            } else if (speechActive && timestamp - speechCandidateSince >= vad.startMs) {
              // Require the same debounce before refreshing the silence timer
              // so a short noise spike cannot keep a turn open forever.
              lastVoiceAt = timestamp;
            }
          } else {
            speechCandidateSince = 0;
            if (speechActive && timestamp - lastVoiceAt >= (vad.silenceMs ?? LOCAL_SILENCE_MS)) {
              commitTurn(timestamp);
            }
          }
          if (speechActive && speechStartedAt && timestamp - speechStartedAt >= vad.maxSpeechMs) {
            callbacks.onStatus?.("connected", "Local VAD: max speech length reached, forcing turn end");
            commitTurn(timestamp);
          }
        } else if (dataChannelReady && turnDetectionMode === "semantic_vad" && semanticSpeechActive && semanticSpeechStartedAt && timestamp - semanticSpeechStartedAt >= vad.maxSpeechMs) {
          callbacks.onStatus?.("connected", "Semantic VAD max speech length reached, forcing safety commit");
          commitSemanticSafetyTurn(timestamp);
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
    semanticSpeechActive = false;
    semanticSpeechStartedAt = 0;
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
      if (event.type === "input_audio_buffer.speech_started" && turnDetectionMode === "semantic_vad") {
        semanticSpeechActive = true;
        semanticSpeechStartedAt = performance.now();
        callbacks.onVad?.({ level: 0, noiseFloor, threshold: Math.max(vad.speechThreshold, noiseFloor * vad.noiseMultiplier + vad.noiseMargin), speechActive: true, calibrated: noiseCalibrated, lastCommitAt });
        callbacks.onStatus?.("connected", "Semantic VAD: speech started");
      }
      if (event.type === "input_audio_buffer.speech_stopped" && turnDetectionMode === "semantic_vad") {
        semanticSpeechActive = false;
        semanticSpeechStartedAt = 0;
        callbacks.onVad?.({ level: 0, noiseFloor, threshold: Math.max(vad.speechThreshold, noiseFloor * vad.noiseMultiplier + vad.noiseMargin), speechActive: false, calibrated: noiseCalibrated, lastCommitAt });
        callbacks.onStatus?.("connected", "Semantic VAD: speech stopped");
      }
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
    const tokenPayload = await tokenResponse.json() as { clientSecret?: string; turnDetection?: TurnDetectionMode };
    if (!tokenPayload.clientSecret) throw new Error("Realtime session did not return a client secret.");
    turnDetectionMode = tokenPayload.turnDetection === "semantic_vad" ? "semantic_vad" : "local_vad";
    callbacks.onTurnDetection?.(turnDetectionMode);
    callbacks.onStatus?.("connecting", `Turn detection: ${turnDetectionMode}`);
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
