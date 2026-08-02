import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { ROBOT_IDS } from "@eidos/shared";
import type { AnalysisResult, KioskPhase, RuntimeStatus } from "@eidos/shared";
import { PresenceDetector, type FaceTelemetry } from "./presence";
import { RealtimeConnectionCancelledError, startRealtimeTranscription, type RealtimeStop } from "./realtime";
import "./styles.css";

const SEARCH = new URLSearchParams(window.location.search);
const MOCK = import.meta.env.VITE_EIDOS_MOCK === "true" || SEARCH.has("mock");
const GALLERY = SEARCH.has("gallery");
const DEBUG_PANEL = import.meta.env.VITE_EIDOS_DEBUG === "true" || import.meta.env.DEV || SEARCH.has("debug");
const REQUEST_FINALIZE_DELAY_MS = 1100;
const WAIT_FOR_EXIT_AUTO_RESET_MS = 5000;
const WAKE_HINT_DELAY_MS = 3500;
const REQUEST_RETRY_TIMEOUT_MS = 15000;
const ROBOT_LOADING_DURATION_MS = 3000;
const ROBOT_SLOT_STEP_MS = 760;
const ROBOT_CARD_SETTLE_MS = 650;

type DebugLog = { time: string; source: string; message: string };

const INITIAL_FACE_TELEMETRY: FaceTelemetry = {
  camera: "disabled",
  detector: "idle",
  faceCount: 0,
  confidence: 0,
  areaRatio: 0,
  stableMs: 0,
  absentMs: 0,
  active: false,
  lastFrameAt: "-",
};

function phaseLabel(phase: KioskPhase): string {
  return {
    boot: "Preparing Eidos",
    idle: "Waiting for a visitor",
    presence: "Visitor detected",
    "realtime-connecting": "Preparing the microphone",
    "wake-listen": "Listening for Eidos",
    "request-listen": "Tell me what you need",
    analyzing: "Your Eidos is coming to life.",
    result: "Result",
    error: "Unable to complete the request",
    "wait-for-exit": "Waiting for the next visitor",
  }[phase];
}

function introVisualIntensity(phase: KioskPhase, stableMs: number, faceActive: boolean): number {
  if (phase === "request-listen") return 1;
  if (phase === "wake-listen") return 1;
  if (phase === "realtime-connecting") return 0.68;
  if (phase === "presence") return 0.34;
  if (phase === "idle" && !faceActive) return Math.min(1, Math.max(0, stableMs / 800)) * 0.34;
  return 0;
}

function normalizeVoiceText(text: string): string {
  return text.toLocaleLowerCase("ko-KR").replace(/[“”"'`.,!?()[\]{}:;<>/\\]/g, " ").replace(/\s+/g, " ").trim();
}

function extractWakeRequest(text: string): { detected: boolean; remainder: string } {
  const normalized = normalizeVoiceText(text);
  const patterns = [
    /\b(?:hi|하이)\s+(?:eidos|아이도스|에이도스)\b/i,
    /(?:hi|하이)\s*(?:eidos|아이도스|에이도스)/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match.index !== undefined) {
      return { detected: true, remainder: normalized.slice(match.index + match[0].length).trim() };
    }
  }
  return { detected: false, remainder: "" };
}

export default function App() {
  const [phase, setPhase] = useState<KioskPhase>("boot");
  const [transcript, setTranscript] = useState("");
  const [requestText, setRequestText] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loadingRobotId, setLoadingRobotId] = useState(ROBOT_IDS[0]);
  const [loadingLocked, setLoadingLocked] = useState(false);
  const [error, setError] = useState("");
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [presenceStatus, setPresenceStatus] = useState("Starting camera");
  const [realtimeStatus, setRealtimeStatus] = useState("Not connected");
  const [operatorOpen, setOperatorOpen] = useState(DEBUG_PANEL);
  const [operatorSessions, setOperatorSessions] = useState<Array<Record<string, unknown>>>([]);
  const [galleryRobotId, setGalleryRobotId] = useState<number | null>(null);
  const [mockRequest, setMockRequest] = useState("새로운 집으로 이사했는데 이삿짐을 정리하고 싶어");
  const [faceTelemetry, setFaceTelemetry] = useState<FaceTelemetry>(INITIAL_FACE_TELEMETRY);
  const [micLevel, setMicLevel] = useState(0);
  const [wakeDetected, setWakeDetected] = useState(false);
  const [wakePromptAttention, setWakePromptAttention] = useState(false);
  const [requestNotice, setRequestNotice] = useState("");
  const [micPaused, setMicPaused] = useState(false);
  const [debugLogs, setDebugLogs] = useState<DebugLog[]>([]);
  const [presenceResetToken, setPresenceResetToken] = useState(0);
  const realtimeStopRef = useRef<RealtimeStop | null>(null);
  const realtimeAbortRef = useRef<AbortController | null>(null);
  const realtimeAttemptRef = useRef(0);
  const sessionIdRef = useRef("");
  const sessionStartedAtRef = useRef("");
  const partialRef = useRef("");
  const wakeDetectedRef = useRef(false);
  const requestRef = useRef("");
  const requestTimerRef = useRef<number | null>(null);
  const wakeTimeoutRef = useRef<number | null>(null);
  const wakeHintTimerRef = useRef<number | null>(null);
  const requestTimeoutRef = useRef<number | null>(null);
  const errorTimeoutRef = useRef<number | null>(null);
  const waitForExitTimerRef = useRef<number | null>(null);
  const loadingRevealTimerRef = useRef<number | null>(null);
  const loadingResultTimerRef = useRef<number | null>(null);
  const loadingTargetRef = useRef<number | null>(null);
  const analysisStartedRef = useRef(false);
  const previousFaceTelemetryRef = useRef(INITIAL_FACE_TELEMETRY);
  const transcriptionLoggedRef = useRef(false);
  const phaseRef = useRef(phase);
  const requestRetryRef = useRef<(() => Promise<void>) | null>(null);
  const micPausedRef = useRef(false);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const appendDebugLog = useCallback((source: string, message: string) => {
    setDebugLogs((previous) => [...previous.slice(-199), { time: new Date().toLocaleTimeString("ko-KR", { hour12: false }), source, message }]);
  }, []);

  const clearTimers = useCallback(() => {
    if (requestTimerRef.current) window.clearTimeout(requestTimerRef.current);
    if (wakeTimeoutRef.current) window.clearTimeout(wakeTimeoutRef.current);
    if (wakeHintTimerRef.current) window.clearTimeout(wakeHintTimerRef.current);
    if (requestTimeoutRef.current) window.clearTimeout(requestTimeoutRef.current);
    if (errorTimeoutRef.current) window.clearTimeout(errorTimeoutRef.current);
    if (waitForExitTimerRef.current) window.clearTimeout(waitForExitTimerRef.current);
    if (loadingRevealTimerRef.current) window.clearTimeout(loadingRevealTimerRef.current);
    if (loadingResultTimerRef.current) window.clearTimeout(loadingResultTimerRef.current);
    requestTimerRef.current = null;
    wakeTimeoutRef.current = null;
    wakeHintTimerRef.current = null;
    requestTimeoutRef.current = null;
    errorTimeoutRef.current = null;
    waitForExitTimerRef.current = null;
    loadingRevealTimerRef.current = null;
    loadingResultTimerRef.current = null;
  }, []);

  const stopRealtime = useCallback(() => {
    realtimeAttemptRef.current += 1;
    realtimeAbortRef.current?.abort();
    realtimeAbortRef.current = null;
    realtimeStopRef.current?.();
    realtimeStopRef.current = null;
    clearTimers();
  }, [clearTimers]);

  const resetToIdle = useCallback((rearmPresence = true) => {
    stopRealtime();
    sessionIdRef.current = "";
    sessionStartedAtRef.current = "";
    partialRef.current = "";
    requestRef.current = "";
    wakeDetectedRef.current = false;
    analysisStartedRef.current = false;
    transcriptionLoggedRef.current = false;
    setWakeDetected(false);
    setWakePromptAttention(false);
    setRequestNotice("");
    setMicLevel(0);
    setRealtimeStatus(rearmPresence ? "reset: waiting for face re-arm" : "auto reset: waiting for visitor exit");
    if (rearmPresence) {
      setPresenceResetToken((token) => token + 1);
      appendDebugLog("state", "Force reset → idle; face tracking re-armed");
    } else {
      appendDebugLog("state", "Thank you timeout → idle; waiting for visitor exit");
    }
    setTranscript("");
    setRequestText("");
    setResult(null);
    setLoadingLocked(false);
    loadingTargetRef.current = null;
    setError("");
    setPhase("idle");
  }, [appendDebugLog, stopRealtime]);

  const enterWaitForExit = useCallback(() => {
    setPhase("wait-for-exit");
    appendDebugLog("state", `Thank you screen → auto reset in ${WAIT_FOR_EXIT_AUTO_RESET_MS / 1000}s`);
    waitForExitTimerRef.current = window.setTimeout(() => resetToIdle(false), WAIT_FOR_EXIT_AUTO_RESET_MS);
  }, [appendDebugLog, resetToIdle]);

  const showError = useCallback((message: string) => {
    stopRealtime();
    setRequestNotice("");
    setWakePromptAttention(false);
    setError(message);
    setPhase("error");
    errorTimeoutRef.current = window.setTimeout(enterWaitForExit, 3000);
  }, [enterWaitForExit, stopRealtime]);

  const pauseMic = useCallback(() => {
    micPausedRef.current = true;
    setMicPaused(true);
    if (wakeTimeoutRef.current) window.clearTimeout(wakeTimeoutRef.current);
    if (requestTimeoutRef.current) window.clearTimeout(requestTimeoutRef.current);
    wakeTimeoutRef.current = null;
    requestTimeoutRef.current = null;
    realtimeStopRef.current?.pause();
    setMicLevel(0);
    setRealtimeStatus("paused by operator");
    appendDebugLog("operator", "Microphone paused");
  }, [appendDebugLog]);

  const resumeMic = useCallback(() => {
    micPausedRef.current = false;
    setMicPaused(false);
    realtimeStopRef.current?.resume();
    setRealtimeStatus(realtimeStopRef.current ? "connected: microphone resumed" : "microphone resume requested");
    appendDebugLog("operator", "Microphone resumed");
    if (MOCK && phaseRef.current === "wake-listen") {
      wakeTimeoutRef.current = window.setTimeout(() => showError("호출어를 들을 수 없었습니다."), 20000);
      wakeHintTimerRef.current = window.setTimeout(() => setWakePromptAttention(true), WAKE_HINT_DELAY_MS);
      return;
    }
    if (phaseRef.current === "wake-listen") {
      wakeTimeoutRef.current = window.setTimeout(() => showError("호출어를 들을 수 없었습니다."), 20000);
    } else if (phaseRef.current === "request-listen") {
      requestTimeoutRef.current = window.setTimeout(() => resetToIdle(false), REQUEST_RETRY_TIMEOUT_MS);
    }
  }, [appendDebugLog, resetToIdle, showError]);

  const resetCounter = useCallback(async (): Promise<string> => {
    try {
      const response = await fetch("/api/operator/counter/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const payload = await response.json() as { ok?: boolean; counter?: number; error?: string };
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? `Counter reset failed (HTTP ${response.status})`);
      const counter = payload.counter ?? 0;
      setRuntime((previous) => previous ? { ...previous, counter } : previous);
      appendDebugLog("operator", "Soma counter reset to 000");
      return "Counter reset to Soma 001";
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Counter reset failed";
      appendDebugLog("operator", message);
      return `Counter reset failed: ${message}`;
    }
  }, [appendDebugLog]);

  const handleOperatorCommand = useCallback(async (command: string): Promise<string> => {
    const normalized = command.trim().toLocaleLowerCase("ko-KR").replace(/^\//, "");
    if (normalized === "mic pause" || normalized === "microphone pause") {
      pauseMic();
      return "Microphone paused";
    }
    if (normalized === "mic resume" || normalized === "microphone resume") {
      resumeMic();
      return "Microphone resumed";
    }
    if (normalized === "mic status" || normalized === "microphone status") {
      return micPausedRef.current ? "Microphone paused" : `Microphone ${realtimeStopRef.current ? "active" : "not connected"}`;
    }
    if (normalized === "counter status") return `Counter Soma ${String(runtime?.counter ?? 0).padStart(3, "0")}`;
    if (normalized === "counter reset") return "Confirmation required: /counter reset confirm";
    if (normalized === "counter reset confirm") return resetCounter();
    appendDebugLog("operator", `Unknown command: ${command.trim() || "(empty)"}`);
    return "Unknown command. Try the quick controls or /counter reset confirm";
  }, [appendDebugLog, pauseMic, resetCounter, resumeMic, runtime?.counter]);

  const handleAudioLevel = useCallback((level: number) => {
    setMicLevel(level);
    if (phaseRef.current !== "wake-listen" || wakeDetectedRef.current || wakePromptAttention || wakeHintTimerRef.current !== null || level < 0.03) return;
    wakeHintTimerRef.current = window.setTimeout(() => {
      wakeHintTimerRef.current = null;
      if (!wakeDetectedRef.current && phaseRef.current === "wake-listen") setWakePromptAttention(true);
    }, WAKE_HINT_DELAY_MS);
  }, [wakePromptAttention]);

  const submitAnalysis = useCallback(async (text: string) => {
    const cleanText = text.trim();
    if (!cleanText || analysisStartedRef.current) return;
    analysisStartedRef.current = true;
    stopRealtime();
    setPhase("analyzing");
    setResult(null);
    setLoadingLocked(false);
    loadingTargetRef.current = null;
    setTranscript(cleanText);
    const started = Date.now();
    const askForRequestAgain = () => {
      analysisStartedRef.current = false;
      partialRef.current = "";
      requestRef.current = "";
      setRequestText("");
      setTranscript("");
      setRequestNotice("죄송합니다.\n다시 말씀해주세요.");
      setPhase("request-listen");
      appendDebugLog("analysis", "Request could not be routed; asking visitor to repeat");
      void requestRetryRef.current?.();
    };
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionIdRef.current || crypto.randomUUID(), transcript: cleanText, startedAt: sessionStartedAtRef.current || new Date().toISOString() }),
      });
      if (!response.ok) {
        let payload: { code?: string; error?: string } = {};
        try {
          payload = await response.json() as { code?: string; error?: string };
        } catch {
          // Keep the generic response error below when the server did not return JSON.
        }
        if (response.status === 422 && payload.code === "unroutable") {
          askForRequestAgain();
          return;
        }
        throw new Error(payload.error ?? `Analysis request failed (HTTP ${response.status})`);
      }
      const nextResult = await response.json() as AnalysisResult;
      if (nextResult.matchedRule === "fallback") {
        askForRequestAgain();
        return;
      }
      setResult(nextResult);
      loadingTargetRef.current = nextResult.robotId;
      const elapsed = Date.now() - started;
      const revealDelay = Math.max(0, ROBOT_LOADING_DURATION_MS - elapsed - ROBOT_CARD_SETTLE_MS);
      loadingRevealTimerRef.current = window.setTimeout(() => {
        loadingRevealTimerRef.current = null;
        setLoadingRobotId(loadingTargetRef.current ?? nextResult.robotId);
        setLoadingLocked(true);
        loadingResultTimerRef.current = window.setTimeout(() => {
          loadingResultTimerRef.current = null;
          setPhase("result");
        }, ROBOT_CARD_SETTLE_MS);
      }, revealDelay);
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "분석에 실패했습니다.");
    }
  }, [appendDebugLog, showError, stopRealtime]);

  const markWake = useCallback((remainder: string) => {
    if (wakeDetectedRef.current) return;
    wakeDetectedRef.current = true;
    if (wakeHintTimerRef.current) window.clearTimeout(wakeHintTimerRef.current);
    wakeHintTimerRef.current = null;
    setWakeDetected(true);
    setWakePromptAttention(false);
    setRequestNotice("");
    appendDebugLog("wakeword", `Hi Eidos detected${remainder ? ` · request: ${remainder}` : ""}`);
    setPhase("request-listen");
    window.clearTimeout(wakeTimeoutRef.current ?? undefined);
    requestTimeoutRef.current = window.setTimeout(() => resetToIdle(false), REQUEST_RETRY_TIMEOUT_MS);
    if (remainder) {
      requestRef.current = remainder;
      setRequestText(remainder);
    }
  }, [appendDebugLog, resetToIdle]);

  const handleTranscriptDelta = useCallback((delta: string) => {
    partialRef.current += delta;
    const current = partialRef.current;
    const wake = extractWakeRequest(current);
    if (!transcriptionLoggedRef.current) {
      transcriptionLoggedRef.current = true;
      appendDebugLog("transcribe", "Partial transcription received");
    }
    if (!wakeDetectedRef.current) {
      setTranscript(current);
      if (wake.detected) markWake(wake.remainder);
    } else {
      setRequestNotice("");
      const requestPart = wake.detected ? wake.remainder : current;
      if (requestPart) {
        if (requestTimerRef.current) window.clearTimeout(requestTimerRef.current);
        requestTimerRef.current = null;
        requestRef.current = requestPart;
        setRequestText(requestPart);
      }
    }
  }, [appendDebugLog, markWake]);

  const handleTranscriptCompleted = useCallback((completed: string) => {
    partialRef.current = "";
    appendDebugLog("transcribe", `Completed: ${completed}`);
    const wake = extractWakeRequest(completed);
    const completedRequest = wake.detected ? wake.remainder : completed.trim();
    if (!wakeDetectedRef.current) {
      if (wake.detected) markWake(wake.remainder);
      else setTranscript(completed);
      if (!wake.detected) return;
    }

    const existing = requestRef.current.trim();
    const nextText = completedRequest && normalizeVoiceText(completedRequest) !== normalizeVoiceText(existing)
      ? [existing, completedRequest].filter(Boolean).join(" ").trim()
      : existing;
    requestRef.current = nextText;
    setRequestText(nextText);
    if (requestTimerRef.current) window.clearTimeout(requestTimerRef.current);
    requestTimerRef.current = nextText
      ? window.setTimeout(() => void submitAnalysis(requestRef.current), REQUEST_FINALIZE_DELAY_MS)
      : null;
  }, [appendDebugLog, markWake, submitAnalysis]);

  const startRequestRetry = useCallback(async () => {
    if (MOCK) {
      setRealtimeStatus("mock: retry listening");
      requestTimeoutRef.current = window.setTimeout(() => resetToIdle(false), REQUEST_RETRY_TIMEOUT_MS);
      return;
    }
    const attempt = realtimeAttemptRef.current + 1;
    realtimeAttemptRef.current = attempt;
    const abortController = new AbortController();
    realtimeAbortRef.current = abortController;
    appendDebugLog("state", "Retry listening started after an unroutable request");
    try {
      const stop = await startRealtimeTranscription({
        onDelta: handleTranscriptDelta,
        onCompleted: handleTranscriptCompleted,
        onStatus: (status, detail) => {
          const nextStatus = detail ? `${status}: ${detail}` : status;
          setRealtimeStatus(nextStatus);
          appendDebugLog("realtime", nextStatus);
        },
        onAudioLevel: handleAudioLevel,
      }, { signal: abortController.signal });
      if (attempt !== realtimeAttemptRef.current || abortController.signal.aborted) {
        stop();
        return;
      }
      realtimeStopRef.current = stop;
      if (micPausedRef.current) {
        stop.pause();
        setRealtimeStatus("paused by operator");
      }
      requestTimeoutRef.current = window.setTimeout(() => resetToIdle(false), REQUEST_RETRY_TIMEOUT_MS);
    } catch (cause) {
      if (attempt !== realtimeAttemptRef.current || cause instanceof RealtimeConnectionCancelledError || abortController.signal.aborted) return;
      showError(cause instanceof Error ? cause.message : "마이크 연결에 실패했습니다.");
    } finally {
      if (realtimeAttemptRef.current === attempt) realtimeAbortRef.current = null;
    }
  }, [appendDebugLog, handleAudioLevel, handleTranscriptCompleted, handleTranscriptDelta, resetToIdle, showError]);

  useEffect(() => {
    requestRetryRef.current = startRequestRetry;
    return () => {
      if (requestRetryRef.current === startRequestRetry) requestRetryRef.current = null;
    };
  }, [startRequestRetry]);

  const startSession = useCallback(async () => {
    if (phase !== "idle" && phase !== "presence") return;
    sessionIdRef.current = crypto.randomUUID();
    sessionStartedAtRef.current = new Date().toISOString();
    wakeDetectedRef.current = false;
    partialRef.current = "";
    requestRef.current = "";
    analysisStartedRef.current = false;
    transcriptionLoggedRef.current = false;
    setWakeDetected(false);
    setWakePromptAttention(false);
    setRequestNotice("");
    setMicLevel(0);
    appendDebugLog("state", "Visitor detected → starting Realtime");
    setTranscript("");
    setRequestText("");
    setError("");
    setResult(null);
    setPhase("realtime-connecting");
    if (MOCK) {
      setPhase("wake-listen");
      if (micPausedRef.current) {
        setRealtimeStatus("paused by operator");
        return;
      }
      wakeTimeoutRef.current = window.setTimeout(() => showError("호출어를 들을 수 없었습니다."), 20000);
      wakeHintTimerRef.current = window.setTimeout(() => setWakePromptAttention(true), WAKE_HINT_DELAY_MS);
      return;
    }
    const attempt = realtimeAttemptRef.current + 1;
    realtimeAttemptRef.current = attempt;
    const abortController = new AbortController();
    realtimeAbortRef.current = abortController;
    try {
      const stop = await startRealtimeTranscription({
        onDelta: handleTranscriptDelta,
        onCompleted: handleTranscriptCompleted,
        onStatus: (status, detail) => {
          const nextStatus = detail ? `${status}: ${detail}` : status;
          setRealtimeStatus(nextStatus);
          appendDebugLog("realtime", nextStatus);
        },
        onAudioLevel: handleAudioLevel,
      }, { signal: abortController.signal });
      if (attempt !== realtimeAttemptRef.current || abortController.signal.aborted) {
        stop();
        return;
      }
      realtimeStopRef.current = stop;
      if (micPausedRef.current) {
        stop.pause();
        setRealtimeStatus("paused by operator");
      }
      if (!wakeDetectedRef.current) {
        setPhase("wake-listen");
        if (!micPausedRef.current) {
          wakeTimeoutRef.current = window.setTimeout(() => showError("호출어를 들을 수 없었습니다."), 20000);
        }
      }
    } catch (cause) {
      if (attempt !== realtimeAttemptRef.current || cause instanceof RealtimeConnectionCancelledError || abortController.signal.aborted) return;
      showError(cause instanceof Error ? cause.message : "마이크 연결에 실패했습니다.");
    } finally {
      if (realtimeAttemptRef.current === attempt) realtimeAbortRef.current = null;
    }
  }, [appendDebugLog, handleAudioLevel, handleTranscriptCompleted, handleTranscriptDelta, phase, showError]);

  const handlePresenceStatus = useCallback((status: string) => {
    setPresenceStatus(status);
    appendDebugLog("camera", status);
  }, [appendDebugLog]);

  const handleFaceTelemetry = useCallback((telemetry: FaceTelemetry) => {
    setFaceTelemetry(telemetry);
    const previous = previousFaceTelemetryRef.current;
    if (previous.camera !== telemetry.camera) appendDebugLog("camera", `Camera: ${telemetry.camera}`);
    if (previous.detector !== telemetry.detector) appendDebugLog("face", `Detector: ${telemetry.detector}`);
    if (previous.active !== telemetry.active) appendDebugLog("face", telemetry.active ? "Face presence confirmed" : "Face presence lost");
    if (previous.faceCount !== telemetry.faceCount) appendDebugLog("face", `Face count: ${telemetry.faceCount}`);
    previousFaceTelemetryRef.current = telemetry;
  }, [appendDebugLog]);

  const handlePresence = useCallback((present: boolean) => {
    if (present) {
      if (phase === "idle") {
        setPhase("presence");
        window.setTimeout(() => void startSession(), 50);
      }
      return;
    }
    if (phase === "result" || phase === "error" || phase === "wait-for-exit") resetToIdle();
    else if (phase !== "idle" && phase !== "boot") resetToIdle();
  }, [phase, resetToIdle, startSession]);

  useEffect(() => {
    fetch("/api/runtime").then((response) => response.json()).then((status: RuntimeStatus) => {
      setRuntime(status);
      setPhase("idle");
      appendDebugLog("runtime", `Ready · assets ${status.availableRobotIds.length}/18 · ${status.mockMode ? "mock" : "live"}`);
    }).catch(() => {
      setPhase("idle");
      setError("Runtime status unavailable");
      appendDebugLog("runtime", "Runtime status unavailable");
    });
  }, [appendDebugLog]);

  useEffect(() => {
    if (phase !== "analyzing" || loadingLocked) return;
    const timer = window.setInterval(() => {
      setLoadingRobotId((current) => {
        const index = ROBOT_IDS.indexOf(current);
        return ROBOT_IDS[(index + 1) % ROBOT_IDS.length];
      });
    }, ROBOT_SLOT_STEP_MS);
    return () => window.clearInterval(timer);
  }, [phase, loadingLocked]);

  useEffect(() => () => stopRealtime(), [stopRealtime]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && event.key.toLocaleLowerCase() === "e") setOperatorOpen((open) => !open);
      if (event.ctrlKey && event.altKey && event.key.toLocaleLowerCase() === "r") resetToIdle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [resetToIdle]);

  useEffect(() => {
    if (!operatorOpen) return;
    fetch("/api/operator/sessions")
      .then((response) => response.json())
      .then((sessions: Array<Record<string, unknown>>) => setOperatorSessions(sessions))
      .catch(() => setOperatorSessions([]));
  }, [operatorOpen, phase]);

  const mockWake = () => markWake("");
  const mockAnalyze = () => void submitAnalysis(mockRequest);
  const introIntensity = introVisualIntensity(phase, faceTelemetry.stableMs, faceTelemetry.active);

  if (GALLERY) return <StateGallery selectedRobotId={galleryRobotId} onSelectRobot={setGalleryRobotId} />;

  return (
    <main className={`kiosk kiosk-${phase} ${operatorOpen ? "kiosk-debug" : ""}`}>
      <PresenceDetector mock={MOCK} enabled={phase !== "boot"} diagnostic={operatorOpen} resetToken={presenceResetToken} onPresence={handlePresence} onStatus={handlePresenceStatus} onTelemetry={handleFaceTelemetry} />
      {phase === "boot" && <section className="screen screen-center"><p className="eyebrow">EIDOS</p><h1>Preparing the experience</h1></section>}
      {(phase === "idle" || phase === "presence" || phase === "realtime-connecting" || phase === "wake-listen" || phase === "request-listen") && <WelcomeScreen mode={phase === "request-listen" ? "request" : "prompt"} ready={phase === "wake-listen"} intensity={introIntensity} wakePromptAttention={phase === "wake-listen" && wakePromptAttention} requestNotice={phase === "request-listen" ? requestNotice : ""} requestText={requestText} micLevel={phase === "wake-listen" || phase === "request-listen" ? micLevel : 0} />}
      {phase === "analyzing" && <RobotLoadingScreen robotId={loadingRobotId} result={result} locked={loadingLocked} />}
      {phase === "result" && result && <ResultScreen result={result} showRobotNumber={operatorOpen} />}
      {phase === "error" && <section className="screen screen-center error-screen"><p className="eyebrow">EIDOS</p><h1>{error || "Something went wrong."}</h1><p className="hint">잠시 후 처음 화면으로 돌아갑니다</p></section>}
      {phase === "wait-for-exit" && <section className="screen screen-center"><p className="eyebrow">EIDOS</p><h1>Thank you.</h1><p className="hint">다음 관람객을 기다리고 있습니다</p></section>}

      {MOCK && <aside className="mock-panel" aria-label="Mock controls">
        <span>MOCK MODE</span>
        <button type="button" onClick={mockWake}>Say “Hi, Eidos”</button>
        <input value={mockRequest} onChange={(event) => setMockRequest(event.target.value)} aria-label="Mock request" />
        <button type="button" onClick={mockAnalyze}>Analyze request</button>
        <button type="button" onClick={() => resetToIdle()}>Reset visitor</button>
        <button type="button" onClick={() => window.location.assign("?mock&gallery")}>Open state gallery</button>
        <small>{phase} · {runtime?.counter ?? 0} · {presenceStatus} · {realtimeStatus}</small>
      </aside>}

      {operatorOpen && <DiagnosticPanel phase={phase} runtime={runtime} presenceStatus={presenceStatus} realtimeStatus={realtimeStatus} faceTelemetry={faceTelemetry} micLevel={micLevel} micPaused={micPaused} wakeDetected={wakeDetected} transcript={transcript} requestText={requestText} logs={debugLogs} sessions={operatorSessions} onClose={() => setOperatorOpen(false)} onReset={resetToIdle} onExport={() => downloadSessions(operatorSessions)} onGallery={() => window.location.assign("?mock&gallery")} onCommand={handleOperatorCommand} onCounterReset={resetCounter} />}
      {!MOCK && <div className="production-status" aria-hidden="true">{runtime?.assetsReady ? "" : "Media pending"}</div>}
    </main>
  );
}

function downloadSessions(sessions: Array<Record<string, unknown>>): void {
  const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `eidos-sessions-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function DiagnosticPanel({
  phase,
  runtime,
  presenceStatus,
  realtimeStatus,
  faceTelemetry,
  micLevel,
  micPaused,
  wakeDetected,
  transcript,
  requestText,
  logs,
  sessions,
  onClose,
  onReset,
  onExport,
  onGallery,
  onCommand,
  onCounterReset,
}: {
  phase: KioskPhase;
  runtime: RuntimeStatus | null;
  presenceStatus: string;
  realtimeStatus: string;
  faceTelemetry: FaceTelemetry;
  micLevel: number;
  micPaused: boolean;
  wakeDetected: boolean;
  transcript: string;
  requestText: string;
  logs: DebugLog[];
  sessions: Array<Record<string, unknown>>;
  onClose: () => void;
  onReset: () => void;
  onExport: () => void;
  onGallery: () => void;
  onCommand: (command: string) => Promise<string>;
  onCounterReset: () => Promise<string>;
}) {
  const signalPercent = Math.round(Math.min(1, micLevel) * 100);
  const [command, setCommand] = useState("");
  const [commandResult, setCommandResult] = useState("");
  const [counterResetArmed, setCounterResetArmed] = useState(false);
  const runOperatorCommand = (value: string) => {
    setCommandResult("Running…");
    void onCommand(value).then(setCommandResult);
  };
  const submitCommand = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runOperatorCommand(command);
    setCommand("");
  };
  return <aside className="diagnostic-panel" aria-label="Eidos development monitor">
    <div className="diagnostic-header"><div><strong>EIDOS DEV MONITOR</strong><span>Live camera · microphone · transcription</span></div><button type="button" onClick={onClose}>Hide</button></div>

    <section className="diagnostic-section diagnostic-state">
      <div className="diagnostic-kicker">STATE MACHINE</div>
      <strong>{phase.toUpperCase()}</strong>
      <span>{phaseLabel(phase)}</span>
      <small>Counter {runtime?.counter ?? 0} · Assets {runtime?.availableRobotIds.length ?? 0}/18</small>
    </section>

    <section className="diagnostic-section">
      <div className="diagnostic-kicker">CAMERA / FACE</div>
      <div className="diagnostic-row"><span>Camera</span><strong className={`status-${faceTelemetry.camera}`}>{faceTelemetry.camera}</strong></div>
      <div className="diagnostic-row"><span>Detector</span><strong className={`status-${faceTelemetry.detector}`}>{faceTelemetry.detector}</strong></div>
      <div className="diagnostic-row"><span>Presence</span><strong className={faceTelemetry.active ? "status-good" : "status-idle"}>{faceTelemetry.active ? "FACE CONFIRMED" : "waiting"}</strong></div>
      <div className="diagnostic-grid"><span>Faces <b>{faceTelemetry.faceCount}</b></span><span>Confidence <b>{faceTelemetry.confidence.toFixed(2)}</b></span><span>Area <b>{(faceTelemetry.areaRatio * 100).toFixed(1)}%</b></span><span>Stable <b>{(faceTelemetry.stableMs / 1000).toFixed(1)}s</b></span><span>Absent <b>{(faceTelemetry.absentMs / 1000).toFixed(1)}s</b></span></div>
      <small className="diagnostic-muted">threshold: confidence ≥ .65 · area ≥ 4% · stable ≥ .8s<br />{presenceStatus} · last frame {faceTelemetry.lastFrameAt}</small>
    </section>

    <section className="diagnostic-section">
      <div className="diagnostic-kicker">MICROPHONE / REALTIME</div>
      <div className="diagnostic-row"><span>Realtime</span><strong className={realtimeStatus.startsWith("connected") ? "status-good" : "status-idle"}>{realtimeStatus}</strong></div>
      <div className="diagnostic-row"><span>Model</span><strong>{runtime?.models.transcription ?? "gpt-live-transcribe"}</strong></div>
      <div className="mic-meter"><span style={{ width: `${signalPercent}%` }} /></div>
      <div className="diagnostic-row"><span>Input level</span><strong className={signalPercent > 1 ? "status-good" : "status-idle"}>{signalPercent}% · {signalPercent > 1 ? "signal received" : "silence / waiting"}</strong></div>
    </section>

    <section className={`diagnostic-section wake-status ${wakeDetected ? "wake-detected" : ""}`}>
      <div className="diagnostic-kicker">WAKEWORD</div>
      <strong>{wakeDetected ? "✓ HI EIDOS DETECTED" : "Listening for Hi Eidos"}</strong>
      <span>{wakeDetected ? "Request listening started" : "Exact wakeword match only"}</span>
    </section>

    <section className="diagnostic-section diagnostic-transcript">
      <div className="diagnostic-kicker">TRANSCRIPT</div>
      <label>Raw / partial<input readOnly value={transcript} placeholder="No transcription yet" /></label>
      <label>Request after wake<input readOnly value={requestText} placeholder="Waiting for wakeword" /></label>
    </section>

    <section className="diagnostic-section diagnostic-log-section">
      <div className="diagnostic-kicker">EVENT LOG</div>
      <div className="diagnostic-log">{logs.length ? logs.slice(-100).reverse().map((log, index) => <div key={`${log.time}-${index}`}><time>{log.time}</time><b>{log.source}</b><span>{log.message}</span></div>) : <span className="diagnostic-muted">No events yet</span>}</div>
    </section>

    <section className="diagnostic-section">
      <div className="diagnostic-kicker">OPERATOR</div>
      <div className="diagnostic-row"><span>Microphone</span><strong className={micPaused ? "status-idle" : "status-good"}>{micPaused ? "PAUSED" : "ACTIVE"}</strong></div>
      <div className="operator-control-label">QUICK CONTROLS</div>
      <div className="operator-actions">
        <button type="button" onClick={() => runOperatorCommand("/mic pause")}>Pause mic</button>
        <button type="button" onClick={() => runOperatorCommand("/mic resume")}>Resume mic</button>
        <button type="button" onClick={() => runOperatorCommand("/mic status")}>Mic status</button>
      </div>
      <div className="operator-actions">
        <button type="button" onClick={() => runOperatorCommand("/counter status")}>Counter status</button>
        <button type="button" className={counterResetArmed ? "operator-danger operator-danger-confirm" : "operator-danger"} onClick={() => {
          if (!counterResetArmed) {
            setCounterResetArmed(true);
            setCommandResult("Click Reset counter again within 5 seconds to confirm.");
            window.setTimeout(() => setCounterResetArmed(false), 5000);
            return;
          }
          setCounterResetArmed(false);
          setCommandResult("Resetting counter…");
          void onCounterReset().then(setCommandResult);
        }}>{counterResetArmed ? "Confirm counter reset" : "Reset counter"}</button>
      </div>
      <form className="operator-command" onSubmit={submitCommand}>
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Optional command" aria-label="Operator command" />
        <button type="submit">Run</button>
      </form>
      {commandResult && <small className="diagnostic-muted">{commandResult}</small>}
      <div className="operator-actions"><button type="button" onClick={onReset}>Force reset</button><button type="button" onClick={onExport}>Export logs</button><button type="button" onClick={onGallery}>Open gallery</button></div>
      <h2>Recent sessions ({sessions.length})</h2>
      <div className="operator-log">{sessions.slice(0, 8).map((session) => <div key={String(session.id)}><strong>{String(session.status)}</strong><span>{String(session.title ?? session.error ?? session.transcript ?? "")}</span></div>)}</div>
    </section>
  </aside>;
}

function Orb({ active = false }: { active?: boolean }) {
  return <div className={`orb ${active ? "orb-active" : ""}`} aria-hidden="true"><span /><span /><span /><span /></div>;
}

function cycleRobotId(robotId: number, offset: number): number {
  const index = Math.max(0, ROBOT_IDS.indexOf(robotId));
  return ROBOT_IDS[(index + offset + ROBOT_IDS.length) % ROBOT_IDS.length];
}

function RobotLoadingScreen({ robotId, result, locked }: { robotId: number; result: AnalysisResult | null; locked: boolean }) {
  const previousId = cycleRobotId(robotId, -1);
  const nextId = cycleRobotId(robotId, 1);
  return <section className={`screen robot-loading ${locked ? "robot-loading-locked" : ""}`} aria-live="polite">
    <p className="robot-loading-headline">Eidos Is Being Born for You</p>
    <div className="robot-card-stack" aria-label="Robot selection in progress">
      <RobotLoadingCard key={previousId} id={previousId} position="previous" />
      <RobotLoadingCard key={robotId} id={robotId} position="active" result={result?.robotId === robotId ? result : null} />
      <RobotLoadingCard key={nextId} id={nextId} position="next" />
    </div>
  </section>;
}

function RobotLoadingCard({ id, position, result }: { id: number; position: "previous" | "active" | "next"; result?: AnalysisResult | null }) {
  const paddedId = String(id).padStart(2, "0");
  const videoUrl = `/media/robot-${paddedId}.webm`;
  const posterUrl = `/media/robot-${paddedId}.webp`;
  const isActive = position === "active";
  const title = result?.title ?? `Eidos Robot ${paddedId}`;
  const serial = result?.displayName ?? `Soma ${String(id).padStart(3, "0")}`;
  return <article className={`robot-card robot-card-${position} robot-card-tone-${(id % 6) + 1}`} aria-hidden={!isActive}>
    <div className="robot-card-header">
      <strong>{title}</strong>
      <span>{serial}</span>
      <small>For You</small>
    </div>
    {isActive
      ? <video autoPlay loop muted playsInline preload="auto" poster={posterUrl} aria-label={`${title} loading preview`}><source src={videoUrl} type="video/webm" /></video>
      : <img src={posterUrl} alt="" loading="eager" />}
    <div className="robot-card-glass" aria-hidden="true" />
  </article>;
}

function ResultScreen({ result, showRobotNumber = false }: { result: AnalysisResult; showRobotNumber?: boolean }) {
  const mp4Url = result.videoUrl.replace(/\.webm$/, ".mp4");
  return <section className="screen result-screen">
    <header><p className="eyebrow">{result.displayName}{showRobotNumber && <span className="debug-robot-id"> · ROBOT {String(result.robotId).padStart(2, "0")}</span>}</p><h1>{result.title}</h1></header>
    <div className="robot-video"><video autoPlay loop muted playsInline poster={result.videoUrl.replace(/\.webm$/, ".webp")}><source src={result.videoUrl} type="video/webm" /><source src={mp4Url} type="video/mp4" /></video></div>
    <footer><span>Required Tasks</span><p>{result.requiredTasks.join(" · ")}</p></footer>
  </section>;
}

function WelcomeScreen({ mode = "prompt", ready = false, intensity = 0, wakePromptAttention = false, requestNotice = "", requestText = "", micLevel = 0 }: { mode?: "prompt" | "request"; ready?: boolean; intensity?: number; wakePromptAttention?: boolean; requestNotice?: string; requestText?: string; micLevel?: number }) {
  const requestMode = mode === "request";
  const hasRequestText = Boolean(requestText.trim());
  return <section className={`screen screen-intro ${ready ? "screen-intro-ready" : "screen-intro-idle"} ${requestMode ? "screen-intro-request" : ""}`}>
    <AmbientField intensity={intensity} micLevel={micLevel} />
    <div className="intro-content" aria-hidden={requestMode}>
      <PromptDock intensity={intensity} attention={wakePromptAttention} />
      {ready && <p className={`intro-hint ${wakePromptAttention ? "intro-hint-attention t-shimmer" : ""}`} data-text="화면을 향해 “Hi, Eidos”라고 말해보세요">화면을 향해 “Hi, Eidos”라고 말해보세요</p>}
    </div>
    <div className="listening-layout" aria-hidden={!requestMode}>
      <div className="listening-heading"><span>I'm Listening,</span><span>Tell me What You Need</span></div>
      <div className="listening-center">
        <p className={`listening-placeholder ${hasRequestText || requestNotice ? "is-hidden" : ""}`}>Eidos에게<br />원하는 도움을 말해보세요.</p>
        <p className={`request-notice ${requestNotice && !hasRequestText ? "is-visible" : "is-hidden"}`} aria-live="polite">{requestNotice}</p>
        <AnimatedTranscript text={requestText} visible={hasRequestText} />
      </div>
      <Orb active />
    </div>
  </section>;
}

function PromptDock({ intensity, attention }: { intensity: number; attention: boolean }) {
  const label = 'Say “Hi, Eidos”';
  const dockIntensity = Math.min(1, Math.max(0, intensity));
  return <div className={`prompt-dock ${attention ? "prompt-dock-attention" : ""}`} style={{ "--dock-intensity": dockIntensity.toFixed(3) } as CSSProperties} role="status" aria-live="polite">
    <span className="prompt-plus" aria-hidden="true">+</span>
    <span className={`prompt-label ${attention ? "t-shimmer" : ""}`} data-text={attention ? label : undefined}>{label}</span>
    <span className="prompt-arrow" aria-hidden="true">→</span>
  </div>;
}

function AnimatedTranscript({ text, visible }: { text: string; visible: boolean }) {
  const parts = text.split(/(\s+)/).filter(Boolean);
  return <p className={`listening-transcript ${visible ? "is-visible" : "is-hidden"}`} aria-live="polite">
    {parts.map((part, index) => /\s+/.test(part)
      ? part
      : <span className="transcript-word t-shimmer" data-text={part} style={{ animationDelay: `${Math.min(index, 6) * 35}ms` }} key={`${index}-${part}`}>{part}</span>)}
  </p>;
}

function AmbientField({ intensity, micLevel }: { intensity: number; micLevel: number }) {
  const visualIntensity = Math.min(1, Math.max(0, intensity));
  const voiceEnergy = Math.min(1, Math.max(0, micLevel * 1.4));
  const style = {
    "--voice-scale": (1 + voiceEnergy * 0.08).toFixed(3),
    "--voice-ring-scale": (1 + voiceEnergy * 0.1).toFixed(3),
    "--ambient-opacity": (0.2 + visualIntensity * 0.8).toFixed(3),
  } as CSSProperties;
  return <div className="ambient-field" style={style} aria-hidden="true">
    <span className="ambient-wave ambient-wave-a" />
    <span className="ambient-wave ambient-wave-b" />
    <span className="ambient-wave ambient-wave-c" />
    <span className="ambient-glow" />
  </div>;
}

function StateGallery({ selectedRobotId, onSelectRobot }: { selectedRobotId: number | null; onSelectRobot: (id: number) => void }) {
  const robotId = selectedRobotId ?? 1;
  const result: AnalysisResult = {
    sessionId: "gallery",
    robotId,
    displayName: `Soma ${String(robotId).padStart(3, "0")}`,
    title: "Gallery Preview",
    requiredTasks: ["Inspect Request", "Prepare Tools", "Complete Task"],
    matchedRule: "semantic",
    videoUrl: `/media/robot-${String(robotId).padStart(2, "0")}.webm`,
  };
  return <main className="gallery-shell">
    <header><p className="eyebrow">EIDOS DEVELOPMENT</p><h1>State &amp; robot gallery</h1><p>Use <code>?mock</code> to exercise the interaction or select a result asset below.</p></header>
    <div className="gallery-states"><span>BOOT</span><span>IDLE</span><span>PRESENCE</span><span>REALTIME_CONNECTING</span><span>WAKE_LISTEN</span><span>REQUEST_LISTEN</span><span>ANALYZING</span><span>RESULT</span><span>WAIT_FOR_EXIT</span></div>
    <section className="gallery-result"><ResultScreen result={result} /></section>
    <section className="gallery-grid">{ROBOT_IDS.map((id) => <button className={id === robotId ? "selected" : ""} type="button" key={id} onClick={() => onSelectRobot(id)}><img src={`/media/robot-${String(id).padStart(2, "0")}.webp`} alt={`Robot ${id}`} /><span>Robot {String(id).padStart(2, "0")}</span></button>)}</section>
  </main>;
}
