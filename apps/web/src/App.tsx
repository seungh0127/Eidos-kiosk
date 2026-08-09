import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ROBOT_IDS } from "@eidos/shared";
import type { AnalysisResult, KioskPhase, RobotCardOffset, RobotCardOffsets, RuntimeStatus } from "@eidos/shared";
import { PresenceDetector, type CameraDevice, type FaceTelemetry } from "./presence";
import { enumerateMicrophoneDevices, RealtimeConnectionCancelledError, startRealtimeTranscription, type MicrophoneDevice, type RealtimeStop, type RealtimeVadConfig, type VadSnapshot } from "./realtime";
import { TextAnimate } from "./registry/magicui/text-animate";
import "./styles.css";

const SEARCH = new URLSearchParams(window.location.search);
const MOCK = import.meta.env.VITE_EIDOS_MOCK === "true" || SEARCH.has("mock");
const GALLERY = SEARCH.has("gallery");
const DEBUG_PANEL = import.meta.env.VITE_EIDOS_DEBUG === "true" || import.meta.env.DEV || SEARCH.has("debug");
// Keep the completed request visible before switching to the Analyse screen.
const REQUEST_FINALIZE_DELAY_MS = 2000;
const WAKE_HINT_DELAY_MS = 3500;
const REQUEST_RETRY_TIMEOUT_MS = 15000;
const MIC_CALIBRATION_PHASE_MS = 7000;
const MICROPHONE_DEVICE_STORAGE_KEY = "eidos.microphoneDeviceId";
// Keep the original visual beat between "face detected" and the wake-listen
// hint. The prompt is also gated by the Realtime-ready phase below.
const INTRO_REVEAL_DELAY_MS = 1000;
// Exit-fade duration once the reels finish holding on their result (matches
// the .robot-loading-locked / robot-loading-out CSS animation).
const ROBOT_CARD_SETTLE_MS = 650;

function savedMicrophoneDeviceId(): string {
  try {
    return window.localStorage.getItem(MICROPHONE_DEVICE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveMicrophoneDeviceId(deviceId: string): void {
  try {
    if (deviceId) window.localStorage.setItem(MICROPHONE_DEVICE_STORAGE_KEY, deviceId);
    else window.localStorage.removeItem(MICROPHONE_DEVICE_STORAGE_KEY);
  } catch {
    // The kiosk can still use the selected device for this page session when
    // localStorage is unavailable (for example, under a restrictive profile).
  }
}

// --- Slot-machine "analyzing" reel tuning ----------------------------------
// Every knob for the reel's choreography lives here. Each row runs a single
// deterministic CSS animation from mount to its own stop time below — not an
// infinite loop that gets interrupted — so the deceleration and the exact
// landing position are both fully predictable. The three stop times are
// deliberately *not* evenly spaced: the H->C gap and the C->L gap are in
// roughly a 2 : 0.7 ratio, so the sequence reads as "tak — tak-tak" (a
// longer beat after the first stop, then the last two catching up quickly)
// rather than a flat, mechanical "tak-tak-tak".
const REEL_STOP_GAP_MS = { hToC: 400, cToL: 140 }; // ~2 : 0.7
const REEL_STOP_MS: Record<"H" | "C" | "L", number> = {
  H: 6500,
  C: 6500 + REEL_STOP_GAP_MS.hToC,
  L: 6500 + REEL_STOP_GAP_MS.hToC + REEL_STOP_GAP_MS.cToL,
};
// How long the fully-stopped H/C/L combination holds on screen (all rows
// frozen) before the exit fade begins.
const REEL_HOLD_MS = 1000;
// Total analyzing-screen duration: last row's stop + hold + exit fade.
// Kept as one explicit value (rather than derived) to avoid reordering the
// const declarations above; update together if any of the three change.
const ROBOT_LOADING_DURATION_MS = REEL_STOP_MS.L + REEL_HOLD_MS + ROBOT_CARD_SETTLE_MS;
// Roughly how many passes through a row's own module set it scrolls before
// landing — purely a distance knob, the pacing lives in .reel-track's
// keyframes (see @keyframes reel-run in styles.css).
const REEL_LOOPS = 1.6;
// The module renders backing each reel row, grouped by the row's code
// letter. Swap or extend these lists to change what appears in a row.
const REEL_MODULE_SETS: Record<"H" | "C" | "L", string[]> = {
  H: ["H-A-1", "H-A-2", "H-A-3", "H-A-4", "H-A-5", "H-B-1", "H-B-2", "H-B-3", "H-B-4", "H-B-5", "H-C-1", "H-C-2", "H-C-3", "H-C-4", "H-C-5", "H-D-1", "H-D-2", "H-D-3", "H-D-4", "H-E-1", "H-E-2"],
  C: ["C-A-1", "C-A-2", "C-A-3", "C-B-1", "C-B-2", "C-B-3", "C-C-1", "C-C-2", "C-C-3", "C-D-1", "C-D-2", "C-E-1", "C-E-2", "C-E-3"],
  L: ["L-A-1", "L-A-2", "L-A-3", "L-B-1", "L-B-2", "L-C-1", "L-C-3", "L-C-4", "L-D-1", "L-D-2", "L-E-1", "L-E-2", "L-F-1", "L-F-2", "L-F-3", "L-G-1"],
};
// Deterministic H/C/L landing per analysis result (robotId 1-18): the reel
// still spins/shuffles as usual, but the module that ends up centered in
// each box is pinned to this table instead of wherever the shuffle happens
// to land. A `null` cell means "no pin" — that row stays fully random for
// that result (per spec: result 7's C reel).
const ROBOT_MODULE_MAP: Record<number, { H: string | null; C: string | null; L: string | null }> = {
  1: { H: "H-A-1", C: "C-A-1", L: "L-A-1" },
  2: { H: "H-B-2", C: "C-A-2", L: "L-A-3" },
  3: { H: "H-C-3", C: "C-B-1", L: "L-D-2" },
  4: { H: "H-D-1", C: "C-D-1", L: "L-B-1" },
  5: { H: "H-D-4", C: "C-C-1", L: "L-B-1" },
  6: { H: "H-A-5", C: "C-D-1", L: "L-G-1" },
  7: { H: "H-C-1", C: null, L: "L-C-1" },
  8: { H: "H-C-2", C: "C-C-2", L: "L-C-3" },
  9: { H: "H-B-5", C: "C-A-1", L: "L-C-1" },
  10: { H: "H-A-4", C: "C-B-3", L: "L-F-3" },
  11: { H: "H-E-2", C: "C-B-1", L: "L-D-1" },
  12: { H: "H-C-2", C: "C-D-1", L: "L-F-2" },
  13: { H: "H-C-5", C: "C-C-3", L: "L-E-1" },
  14: { H: "H-D-3", C: "C-D-1", L: "L-A-3" },
  15: { H: "H-D-4", C: "C-C-1", L: "L-B-2" },
  16: { H: "H-B-5", C: "C-D-1", L: "L-A-2" },
  17: { H: "H-B-2", C: "C-C-2", L: "L-A-3" },
  18: { H: "H-E-1", C: "C-E-3", L: "L-F-1" },
};
// Computed once at module scope (not inline in JSX) so each row's image
// array keeps a stable identity across renders.
const REEL_ROW_IMAGES: Record<"H" | "C" | "L", string[]> = {
  H: REEL_MODULE_SETS.H.map((name) => `/assets/H/${name}.png`),
  C: REEL_MODULE_SETS.C.map((name) => `/assets/C/${name}.png`),
  L: REEL_MODULE_SETS.L.map((name) => `/assets/L/${name}.png`),
};
/** Fisher-Yates shuffle, non-mutating. Used to re-order each reel's modules
 *  independently every time the analyzing screen mounts (see ReelTrack). */
function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
// Two copies of each row are rendered back to back (see ReelTrack) so the
// reel always has real content to show up to its final scrolled position.
const REEL_COPIES = 2;
/** How many items the reel scrolls through before landing — the single
 *  source both the CSS distance (reelFinalOffset) and the landing INDEX
 *  (REEL_LANDING_INDEX, used to pin a specific module there) derive from. */
function reelItemsScrolled(itemCount: number): number {
  return Math.round(itemCount * REEL_LOOPS);
}
/**
 * A CSS calc() expression (not a percentage of the track's own width) that
 * lands the target item's *center* exactly on the row/box center (50cqw —
 * the track's left edge always sits at the row's left edge, i.e. 0cqw).
 * Built from --slot-size and --slot-item-gap so it stays exact no matter
 * how those two are retuned, instead of the old percent-of-track-width
 * approximation, which drifted off-box once item/gap sizing changed.
 */
function reelFinalOffset(itemsScrolled: number): string {
  const cell = "(var(--slot-size) * .9 + var(--slot-item-gap))";
  const halfItem = "(var(--slot-size) * .45)";
  return `calc(50cqw - (${itemsScrolled} * ${cell}) - ${halfItem})`;
}
const REEL_ITEMS_SCROLLED: Record<"H" | "C" | "L", number> = {
  H: reelItemsScrolled(REEL_MODULE_SETS.H.length),
  C: reelItemsScrolled(REEL_MODULE_SETS.C.length),
  L: reelItemsScrolled(REEL_MODULE_SETS.L.length),
};
const REEL_FINAL_OFFSET: Record<"H" | "C" | "L", string> = {
  H: reelFinalOffset(REEL_ITEMS_SCROLLED.H),
  C: reelFinalOffset(REEL_ITEMS_SCROLLED.C),
  L: reelFinalOffset(REEL_ITEMS_SCROLLED.L),
};
// strip = [...images, ...images] (REEL_COPIES=2) and itemsScrolled always
// lands in the second copy (REEL_LOOPS > 1), so the landing element is
// images[itemsScrolled % itemCount] — this is the array index ReelTrack
// pins the target module into.
const REEL_LANDING_INDEX: Record<"H" | "C" | "L", number> = {
  H: REEL_ITEMS_SCROLLED.H % REEL_MODULE_SETS.H.length,
  C: REEL_ITEMS_SCROLLED.C % REEL_MODULE_SETS.C.length,
  L: REEL_ITEMS_SCROLLED.L % REEL_MODULE_SETS.L.length,
};
const RESULT_GREETING_DELAY_MS = 1000;
// If the visitor hasn't said anything within this long after the
// request-listen prompt appears, swap the generic instruction for a
// concrete example request, then keep alternating between the two on
// this same interval for as long as the visitor stays silent — see
// RequestPrompt.
const REQUEST_EXAMPLE_DELAY_MS = 2500;
// Each example's line break is fixed by design — keep as an array of lines
// rather than a single string so RequestPrompt can render it with the same
// <br /> structure as the default instruction.
const REQUEST_EXAMPLES: string[][] = [
  ["이삿짐들을 정리하고,", "집을 꾸며줘."],
  ["여행 기간동안", "강아지를 케어해줘."],
  ["나의 러닝 메이트가 되어줘."],
];
// Safety net: if neither a hand wave nor a spoken greeting is ever detected
// (camera/mic trouble, or the visitor just doesn't gesture), the greeting
// card would otherwise wait forever — nothing currently moves it forward on
// its own. This guarantees it always eventually continues.
const GREETING_TIMEOUT_MS = 15000;
const PHOTO_ONBOARDING_MS = 2000;
const PHOTO_CAPTURE_MS = 30000;
const MOCK_TRANSCRIPTION_TEXT = "새로운 집으로 이사했는데 이삿짐을 정리하고 싶어";
const MOCK_TRANSCRIPTION_STEP_MS = 220;
// Deliberately matches none of mockAnalyzeLocally's routing keywords, so it
// always resolves matchedRule: "fallback" — lets the mock panel trigger the
// "request could not be routed" screen (askForRequestAgain) on demand.
const MOCK_UNROUTABLE_TEXT = "인식할 수 없는 요청 테스트입니다";
const SOUND_SOURCES = {
  eidos: "/assets/S-Eidos.mp3",
  request: "/assets/S-REQUEST-LISTEN.wav",
  analyzing: "/assets/S-ANALYZING.wav",
} as const;

const MOCK_RUNTIME_STATUS: RuntimeStatus = {
  counter: 0,
  assetsReady: true,
  availableRobotIds: ROBOT_IDS,
  models: { routing: "local-mock-routing", transcription: "local-mock-transcription", realtime: "local-mock-realtime" },
  mockMode: true,
};

// --- Photo-card robot position/size (per robotId, 1-18) ---------------------
// The base box .result-card-back-robot sits in (see styles.css); each robot's
// own scale/position can override this — see RobotCardOffset in @eidos/shared
// and the ?gallery Photo-card tab's live tuning controls (StateGallery).
const ROBOT_CARD_BASE_TOP = 7.4;
const ROBOT_CARD_BASE_LEFT = 9.8;
const ROBOT_CARD_DEFAULT_OFFSET: RobotCardOffset = { scale: 1, top: ROBOT_CARD_BASE_TOP, left: ROBOT_CARD_BASE_LEFT };
// Starting scale per robot, measured from each robot-NN.webm's actual
// on-frame size via ffmpeg cropdetect (the 18 source videos don't frame
// their robot at a consistent scale within their own frame). Live-tunable
// and persisted from here on — this is only the seed for a robot that has
// never been saved before.
const ROBOT_CARD_DEFAULT_SCALE: Record<number, number> = {
  1: .94, 2: .97, 3: .95, 4: .97, 5: .88, 6: 1.01, 7: 1.16, 8: .97, 9: 1.01,
  10: 1.19, 11: .99, 12: 1.02, 13: .99, 14: 1.18, 15: .91, 16: .93, 17: 1.03, 18: 1.03,
};
const DEFAULT_ROBOT_CARD_OFFSETS: RobotCardOffsets = Object.fromEntries(
  ROBOT_IDS.map((id) => [id, { scale: ROBOT_CARD_DEFAULT_SCALE[id] ?? 1, top: ROBOT_CARD_BASE_TOP, left: ROBOT_CARD_BASE_LEFT }]),
);
function robotCardOffsetFor(offsets: RobotCardOffsets, robotId: number): RobotCardOffset {
  return offsets[robotId] ?? DEFAULT_ROBOT_CARD_OFFSETS[robotId] ?? ROBOT_CARD_DEFAULT_OFFSET;
}

type SoundKey = keyof typeof SOUND_SOURCES;
type ResultPhotoStage = "card" | "greeting" | "photo-onboarding" | "photo-capture";

type DebugLog = { time: string; source: string; message: string };

type MicCalibrationPhase = "idle" | "noise" | "voice" | "complete" | "error";
type MicCalibrationState = {
  phase: MicCalibrationPhase;
  noiseFloor: number | null;
  voiceFloor: number | null;
  voicePeak: number | null;
  suggestedThreshold: number | null;
  message: string;
};

const INITIAL_MIC_CALIBRATION: MicCalibrationState = {
  phase: "idle",
  noiseFloor: null,
  voiceFloor: null,
  voicePeak: null,
  suggestedThreshold: null,
  message: "기본 VAD 설정을 사용 중입니다.",
};

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index] ?? 0;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

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
    analyzing: "Your Eidos is coming to life",
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
  if (phase === "idle" && !faceActive) return Math.min(1, Math.max(0, stableMs / 500)) * 0.34;
  return 0;
}

function normalizeVoiceText(text: string): string {
  return text.toLocaleLowerCase("ko-KR").replace(/[“”"'`.,!?()[\]{}:;<>/\\]/g, " ").replace(/\s+/g, " ").trim();
}

function extractWakeRequest(text: string): { detected: boolean; remainder: string } {
  const normalized = normalizeVoiceText(text);
  // Wake word is just "Eidos"/"에이도스" now — no "Hi"/"하이" prefix required.
  // \b doesn't apply to Hangul (it only recognizes ASCII word characters), so
  // the Korean forms need their own boundary-free pattern.
  const patterns = [
    /\beidos\b/i,
    /(?:아이도스|에이도스)/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match.index !== undefined) {
      return { detected: true, remainder: normalized.slice(match.index + match[0].length).trim() };
    }
  }
  return { detected: false, remainder: "" };
}

// Spoken greeting on the result card ("안녕" / "안녕하세요" / "안녕하십니까" all
// contain this substring) — an alternative to the camera hand-wave trigger,
// since hand detection alone proved unreliable at real kiosk distances.
const GREETING_PATTERN = /안녕/;
function containsGreeting(text: string): boolean {
  return GREETING_PATTERN.test(normalizeVoiceText(text));
}

/**
 * Keep mock mode completely offline. This is a small deterministic equivalent
 * of the server's mock router; it is intentionally not used in live mode.
 */
function mockAnalyzeLocally(transcript: string, sessionId: string): AnalysisResult {
  const text = normalizeVoiceText(transcript);
  let robotId = 1;
  let matchedRule: AnalysisResult["matchedRule"] = "fallback";

  if (/집을\s*(?:지켜|봐)|집을\s*돌봐|집을\s*살펴/.test(text)) {
    robotId = 2;
    matchedRule = "hidden-code";
  } else if (/이삿짐|무거운|중량|큰\s*짐|화물|카트|장비를\s*옮|옮겨|운반/.test(text)) {
    robotId = /끌어|견인|카트/.test(text) ? 8 : 4;
    matchedRule = "group-d";
  } else if (/산책|따라다니|따라와|낮은\s*곳|순찰|배변/.test(text)) {
    robotId = 7;
    matchedRule = "group-b";
  } else if (/아이|어린이|반려동물|강아지|고양이|놀아|장난감|교감/.test(text)) {
    robotId = 2;
    matchedRule = "group-b";
  } else if (/스캔|3d\s*지도|공간\s*매핑|디지털\s*트윈/.test(text)) {
    robotId = 18;
    matchedRule = "environment";
  } else if (/물청소|세척|수영장|침수|습윤|배수구|물\s*청소/.test(text)) {
    robotId = 14;
    matchedRule = "environment";
  } else if (/눈|스키장|설원|스노우|눈길/.test(text)) {
    robotId = 12;
    matchedRule = "environment";
  } else if (/집|심부름|가져다|정리/.test(text)) {
    robotId = /여러\s*가지|잔뜩|한번에|종류별|많이/.test(text) ? 17 : 1;
    matchedRule = "group-a";
  }

  const content: Record<number, { title: string; tasks: string[] }> = {
    1: { title: "Indoor Errand Support", tasks: ["Light Object Delivery", "Indoor Errands", "Small Item Carrying"] },
    2: { title: "Companion Support", tasks: ["Safe Interaction", "Pet-Friendly Play", "Short Companion Walks"] },
    4: { title: "Heavy Load Transport", tasks: ["Heavy Object Transport", "Boxes and Equipment", "Room-to-Room Movement"] },
    7: { title: "Low-Space Companion", tasks: ["Following", "Low-Space Inspection", "Small Load Carrying"] },
    8: { title: "Heavy Towing Support", tasks: ["Towing", "Equipment Movement", "Heavy Positioning"] },
    12: { title: "Winter Supply Support", tasks: ["Snow Travel", "Supply Transport", "Ski-Area Support"] },
    14: { title: "Wet Area Support", tasks: ["Water Cleaning", "Washing", "Drainage Support"] },
    17: { title: "Mobile Supply Support", tasks: ["Many-Item Storage", "Bulk Light-Item Carrying", "Mobile Supply"] },
    18: { title: "Spatial Scan Support", tasks: ["Scanning", "3D Mapping", "Spatial Recording"] },
  };
  const selected = content[robotId] ?? { title: "Eidos Support", tasks: ["Daily Assistance", "Object Handling", "Visitor Support"] };
  return {
    sessionId,
    robotId,
    displayName: "",
    title: selected.title,
    requiredTasks: selected.tasks,
    matchedRule,
    videoUrl: `/media/robot-${String(robotId).padStart(2, "0")}.webm`,
  };
}

export default function App() {
  const [phase, setPhase] = useState<KioskPhase>("boot");
  const [transcript, setTranscript] = useState("");
  const [requestText, setRequestText] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [resultPhotoStage, setResultPhotoStage] = useState<ResultPhotoStage>("card");
  const [loadingLocked, setLoadingLocked] = useState(false);
  const [error, setError] = useState("");
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [robotCardOffsets, setRobotCardOffsets] = useState<RobotCardOffsets>(DEFAULT_ROBOT_CARD_OFFSETS);
  const [presenceStatus, setPresenceStatus] = useState("Starting camera");
  const [realtimeStatus, setRealtimeStatus] = useState("Not connected");
  const [turnDetectionMode, setTurnDetectionMode] = useState<"unknown" | "semantic_vad">("unknown");
  const [operatorOpen, setOperatorOpen] = useState(DEBUG_PANEL);
  const [screenRotated, setScreenRotated] = useState(false);
  const [cameraDevices, setCameraDevices] = useState<CameraDevice[]>([]);
  const [cameraDeviceId, setCameraDeviceId] = useState("");
  const [microphoneDevices, setMicrophoneDevices] = useState<MicrophoneDevice[]>([]);
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState(savedMicrophoneDeviceId);
  const [activeMicrophoneDeviceId, setActiveMicrophoneDeviceId] = useState("");
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [operatorSessions, setOperatorSessions] = useState<Array<Record<string, unknown>>>([]);
  const [galleryRobotId, setGalleryRobotId] = useState<number | null>(null);
  const [mockRequest, setMockRequest] = useState("새로운 집으로 이사했는데 이삿짐을 정리하고 싶어");
  const [faceTelemetry, setFaceTelemetry] = useState<FaceTelemetry>(INITIAL_FACE_TELEMETRY);
  const [micLevel, setMicLevel] = useState(0);
  const [wakeDetected, setWakeDetected] = useState(false);
  const [wakePromptAttention, setWakePromptAttention] = useState(false);
  // Face detection confirms presence instantly, but popping the wake-listen
  // hint text/animation in on that exact frame reads as an abrupt jump cut.
  // This flips true INTRO_REVEAL_DELAY_MS after presence is confirmed, so
  // there's a beat of "the system noticed you" before the UI responds —
  // see handlePresence.
  const [introRevealed, setIntroRevealed] = useState(false);
  const [requestPromptVisible, setRequestPromptVisible] = useState(false);
  // Bumped by MockPanel's "Preview text morph" button so RequestPrompt can
  // force an immediate example swap without waiting out the interval —
  // lets a dev/operator preview the morph transition on demand.
  const [exampleMorphTrigger, setExampleMorphTrigger] = useState(0);
  const [requestNotice, setRequestNotice] = useState("");
  const [micPaused, setMicPaused] = useState(false);
  const [requestLockEnabled, setRequestLockEnabled] = useState(false);
  const [requestTurnLocked, setRequestTurnLocked] = useState(false);
  const [vadSnapshot, setVadSnapshot] = useState<VadSnapshot | null>(null);
  const [micCalibration, setMicCalibration] = useState<MicCalibrationState>(INITIAL_MIC_CALIBRATION);
  const [debugLogs, setDebugLogs] = useState<DebugLog[]>([]);
  const [presenceResetToken, setPresenceResetToken] = useState(0);
  // Bumped on every resetToIdle() call so a keyed overlay remounts (and its
  // fade-from-black animation restarts) each time the app returns to the
  // idle screen, instead of hard-cutting between screens.
  const [resetFadeKey, setResetFadeKey] = useState(0);
  const realtimeStopRef = useRef<RealtimeStop | null>(null);
  const realtimeAbortRef = useRef<AbortController | null>(null);
  const realtimeAttemptRef = useRef(0);
  const sessionIdRef = useRef("");
  const sessionStartedAtRef = useRef("");
  const partialRef = useRef("");
  const wakeDetectedRef = useRef(false);
  const requestRef = useRef("");
  const requestTimerRef = useRef<number | null>(null);
  const mockTranscriptionTimerRef = useRef<number | null>(null);
  const wakeTimeoutRef = useRef<number | null>(null);
  const wakeHintTimerRef = useRef<number | null>(null);
  const requestTimeoutRef = useRef<number | null>(null);
  const loadingRevealTimerRef = useRef<number | null>(null);
  const loadingResultTimerRef = useRef<number | null>(null);
  const resultStageTimerRef = useRef<number | null>(null);
  const introRevealTimerRef = useRef<number | null>(null);
  const mockPhotoWavePendingRef = useRef(false);
  const greetingPartialRef = useRef("");
  const greetingHandledRef = useRef(false);
  const analysisStartedRef = useRef(false);
  const eidosSoundPlayedRef = useRef(false);
  const requestSoundPlayedRef = useRef(false);
  const soundRefs = useRef<Partial<Record<SoundKey, HTMLAudioElement>>>({});
  const previousFaceTelemetryRef = useRef(INITIAL_FACE_TELEMETRY);
  // Mirrors faceTelemetry.active without waiting on a render, so the
  // request-listen no-speech timeout (see scheduleRequestTimeout) can check
  // "is a face on camera right now" at the moment it fires.
  const faceActiveRef = useRef(false);
  const transcriptionLoggedRef = useRef(false);
  const phaseRef = useRef(phase);
  const requestRetryRef = useRef<(() => Promise<void>) | null>(null);
  const micPausedRef = useRef(false);
  const requestLockEnabledRef = useRef(false);
  const requestTurnLockedRef = useRef(false);
  const vadOverrideRef = useRef<RealtimeVadConfig>({});
  const micCalibrationPhaseRef = useRef<MicCalibrationPhase>("idle");
  const micCalibrationTimerRef = useRef<number | null>(null);
  const micCalibrationRunRef = useRef(0);
  const micCalibrationDeadlineRef = useRef(0);
  const micCalibrationPhaseStartedAtRef = useRef(0);
  const calibrationNoiseLevelsRef = useRef<number[]>([]);
  const calibrationVoiceLevelsRef = useRef<number[]>([]);
  const lastVadCommitRef = useRef<number | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const sounds = Object.fromEntries(
      (Object.entries(SOUND_SOURCES) as Array<[SoundKey, string]>).map(([key, source]) => {
        const audio = new Audio(source);
        audio.preload = "auto";
        return [key, audio];
      }),
    ) as Partial<Record<SoundKey, HTMLAudioElement>>;
    soundRefs.current = sounds;
    return () => {
      Object.values(sounds).forEach((audio) => {
        audio?.pause();
        audio?.removeAttribute("src");
        audio?.load();
      });
      soundRefs.current = {};
    };
  }, []);

  const appendDebugLog = useCallback((source: string, message: string) => {
    setDebugLogs((previous) => [...previous.slice(-199), { time: new Date().toLocaleTimeString("ko-KR", { hour12: false }), source, message }]);
  }, []);

  const refreshMicrophoneDevices = useCallback(async () => {
    try {
      setMicrophoneDevices(await enumerateMicrophoneDevices());
    } catch {
      setMicrophoneDevices([]);
    }
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return undefined;
    void refreshMicrophoneDevices();
    const handleDeviceChange = () => void refreshMicrophoneDevices();
    mediaDevices.addEventListener?.("devicechange", handleDeviceChange);
    return () => mediaDevices.removeEventListener?.("devicechange", handleDeviceChange);
  }, [refreshMicrophoneDevices]);

  const handleMicrophoneDevices = useCallback((devices: MicrophoneDevice[], activeDeviceId: string, selectionFallback: boolean) => {
    if (devices.length) setMicrophoneDevices(devices);
    setActiveMicrophoneDeviceId(activeDeviceId);
    if (!selectionFallback) return;
    setMicrophoneDeviceId("");
    saveMicrophoneDeviceId("");
    appendDebugLog("microphone", "Saved microphone unavailable · switched to automatic selection");
  }, [appendDebugLog]);

  const handleMicrophoneDeviceChange = useCallback((deviceId: string) => {
    setMicrophoneDeviceId(deviceId);
    saveMicrophoneDeviceId(deviceId);
    const label = microphoneDevices.find((device) => device.deviceId === deviceId)?.label;
    appendDebugLog("microphone", deviceId ? `Selected ${label ?? "microphone"} · applies on next Realtime connection` : "Using automatic microphone selection on next Realtime connection");
  }, [appendDebugLog, microphoneDevices]);

  const handleVadSnapshot = useCallback((snapshot: VadSnapshot) => {
    setVadSnapshot(snapshot);
    if (snapshot.lastCommitAt !== null && snapshot.lastCommitAt !== lastVadCommitRef.current) {
      lastVadCommitRef.current = snapshot.lastCommitAt;
      appendDebugLog("realtime", `Semantic VAD safety commit · level ${snapshot.level.toFixed(3)} · meter threshold ${snapshot.threshold.toFixed(3)}`);
    }
  }, [appendDebugLog]);

  const handleTurnDetection = useCallback((mode: "semantic_vad") => {
    setTurnDetectionMode(mode);
    appendDebugLog("realtime", `Turn detection selected: ${mode}`);
  }, [appendDebugLog]);

  const playSound = useCallback((key: SoundKey) => {
    const audio = soundRefs.current[key];
    if (!audio) return;
    audio.currentTime = 0;
    void audio.play().catch(() => {
      appendDebugLog("audio", `${key} playback was blocked by the browser`);
    });
  }, [appendDebugLog]);

  const playSoundOnce = useCallback((key: SoundKey, playedRef: { current: boolean }) => {
    if (playedRef.current) return;
    playedRef.current = true;
    playSound(key);
  }, [playSound]);

  const clearTimers = useCallback(() => {
    if (requestTimerRef.current) window.clearTimeout(requestTimerRef.current);
    if (mockTranscriptionTimerRef.current) window.clearTimeout(mockTranscriptionTimerRef.current);
    if (wakeTimeoutRef.current) window.clearTimeout(wakeTimeoutRef.current);
    if (wakeHintTimerRef.current) window.clearTimeout(wakeHintTimerRef.current);
    if (requestTimeoutRef.current) window.clearTimeout(requestTimeoutRef.current);
    if (loadingRevealTimerRef.current) window.clearTimeout(loadingRevealTimerRef.current);
    if (loadingResultTimerRef.current) window.clearTimeout(loadingResultTimerRef.current);
    if (resultStageTimerRef.current) window.clearTimeout(resultStageTimerRef.current);
    if (introRevealTimerRef.current) window.clearTimeout(introRevealTimerRef.current);
    if (micCalibrationTimerRef.current) window.clearTimeout(micCalibrationTimerRef.current);
    requestTimerRef.current = null;
    mockTranscriptionTimerRef.current = null;
    wakeTimeoutRef.current = null;
    wakeHintTimerRef.current = null;
    requestTimeoutRef.current = null;
    introRevealTimerRef.current = null;
    loadingRevealTimerRef.current = null;
    loadingResultTimerRef.current = null;
    resultStageTimerRef.current = null;
    micCalibrationTimerRef.current = null;
    micCalibrationRunRef.current += 1;
    micCalibrationDeadlineRef.current = 0;
    micCalibrationPhaseStartedAtRef.current = 0;
  }, []);

  // Tears down only the realtime mic/data connection, without touching any
  // of the app's other pending timers (see clearTimers). Used where a
  // cleanup genuinely only means "stop listening" — e.g. leaving the
  // greeting stage's voice-greeting listener — so it doesn't also cancel an
  // unrelated timer that happens to share clearTimers, like the
  // photo-onboarding -> photo-capture transition in startPhotoFlow.
  const stopRealtimeConnection = useCallback(() => {
    realtimeAttemptRef.current += 1;
    realtimeAbortRef.current?.abort();
    realtimeAbortRef.current = null;
    realtimeStopRef.current?.();
    realtimeStopRef.current = null;
  }, []);

  const stopRealtime = useCallback(() => {
    stopRealtimeConnection();
    clearTimers();
  }, [clearTimers, stopRealtimeConnection]);

  const resetToIdle = useCallback((rearmPresence = true) => {
    stopRealtime();
    sessionIdRef.current = "";
    sessionStartedAtRef.current = "";
    partialRef.current = "";
    requestRef.current = "";
    requestTurnLockedRef.current = false;
    wakeDetectedRef.current = false;
    analysisStartedRef.current = false;
    eidosSoundPlayedRef.current = false;
    requestSoundPlayedRef.current = false;
    transcriptionLoggedRef.current = false;
    setWakeDetected(false);
    setWakePromptAttention(false);
    setIntroRevealed(false);
    setRequestPromptVisible(false);
    setRequestNotice("");
    setMicLevel(0);
    setRequestTurnLocked(false);
    setVadSnapshot(null);
    if (micCalibrationPhaseRef.current === "noise" || micCalibrationPhaseRef.current === "voice") {
      if (micCalibrationTimerRef.current) window.clearTimeout(micCalibrationTimerRef.current);
      micCalibrationTimerRef.current = null;
      calibrationNoiseLevelsRef.current = [];
      calibrationVoiceLevelsRef.current = [];
      micCalibrationPhaseRef.current = "idle";
      setMicCalibration((previous) => ({ ...previous, phase: "idle", message: "보정이 취소되었습니다. 기본값 또는 직전 완료값을 사용합니다." }));
    }
    setRealtimeStatus(rearmPresence ? "reset: waiting for face re-arm" : "auto reset: waiting for visitor exit");
    setTurnDetectionMode("unknown");
    if (rearmPresence) {
      setPresenceResetToken((token) => token + 1);
      appendDebugLog("state", "Force reset → idle; face tracking re-armed");
    } else {
      appendDebugLog("state", "Thank you timeout → idle; waiting for visitor exit");
    }
    setTranscript("");
    setRequestText("");
    setResult(null);
    setResultPhotoStage("card");
    mockPhotoWavePendingRef.current = false;
    setLoadingLocked(false);
    setError("");
    setPhase("idle");
    setResetFadeKey((key) => key + 1);
  }, [appendDebugLog, stopRealtime]);

  const handleWakeTimeout = useCallback(() => {
    appendDebugLog("state", "Wake window elapsed → idle (no wakeword heard)");
    resetToIdle();
  }, [appendDebugLog, resetToIdle]);

  const showError = useCallback((message: string) => {
    appendDebugLog("state", `Realtime error → idle; waiting for visitor exit: ${message}`);
    // Do not re-arm face presence while the same visitor is still in frame.
    // Otherwise a failed client-secret request immediately starts another
    // microphone session and appears as a refresh/retry loop.
    resetToIdle(false);
  }, [appendDebugLog, resetToIdle]);

  // Drives the request-listen "no speech heard" timeout. A visitor who is
  // still on camera shouldn't be bounced back to idle just for staying
  // quiet — only a face leaving the frame should end the session (handled
  // separately by handlePresence). So instead of resetting outright when
  // the timer elapses, check whether a face is still detected: if so, the
  // visitor is still there, and we simply keep waiting; only reset once
  // the face itself is gone.
  const scheduleRequestTimeout = useCallback(() => {
    if (requestTimeoutRef.current) window.clearTimeout(requestTimeoutRef.current);
    const check = () => {
      if (faceActiveRef.current) {
        requestTimeoutRef.current = window.setTimeout(check, REQUEST_RETRY_TIMEOUT_MS);
        return;
      }
      resetToIdle(false);
    };
    requestTimeoutRef.current = window.setTimeout(check, REQUEST_RETRY_TIMEOUT_MS);
  }, [resetToIdle]);

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
      wakeTimeoutRef.current = window.setTimeout(handleWakeTimeout, 20000);
      wakeHintTimerRef.current = window.setTimeout(() => setWakePromptAttention(true), WAKE_HINT_DELAY_MS);
      return;
    }
    if (phaseRef.current === "wake-listen") {
      wakeTimeoutRef.current = window.setTimeout(handleWakeTimeout, 20000);
    } else if (phaseRef.current === "request-listen") {
      scheduleRequestTimeout();
    }
  }, [appendDebugLog, handleWakeTimeout, scheduleRequestTimeout]);

  const finishMicCalibration = useCallback((runId: number) => {
    if (runId !== micCalibrationRunRef.current || micCalibrationPhaseRef.current !== "voice") return;
    const remainingMs = micCalibrationDeadlineRef.current - performance.now();
    if (remainingMs > 0) {
      // A stale/early timer must never shorten the voice window. Re-arm from
      // the absolute deadline rather than trusting the original timeout.
      micCalibrationTimerRef.current = window.setTimeout(() => finishMicCalibration(runId), Math.ceil(remainingMs) + 20);
      return;
    }
    micCalibrationTimerRef.current = null;
    const voiceElapsedMs = performance.now() - micCalibrationPhaseStartedAtRef.current;
    const noiseSamples = calibrationNoiseLevelsRef.current;
    const voiceSamples = calibrationVoiceLevelsRef.current;
    // Treat short ambient bursts as part of the real noise environment. A
    // quiet average is too optimistic for an exhibition hall.
    const noiseFloor = percentile(noiseSamples, 0.95);
    // The visitor should keep speaking during the full voice window. Using a
    // middle percentile makes a one-off loud sample insufficient to pass.
    const voiceFloor = percentile(voiceSamples, 0.35);
    const voicePeak = percentile(voiceSamples, 0.95);
    const separation = voiceFloor - noiseFloor;

    if (noiseSamples.length < 20 || voiceSamples.length < 20 || separation < 0.02) {
      micCalibrationPhaseRef.current = "error";
      setMicCalibration({
        phase: "error",
        noiseFloor,
        voiceFloor,
        voicePeak,
        suggestedThreshold: null,
        message: "소음과 테스트 발화를 충분히 구분하지 못했습니다. 주변 소리가 줄어든 뒤 7초 동안 계속 말하며 다시 시도해주세요.",
      });
      appendDebugLog("operator", `Mic calibration failed · voice window ${Math.round(voiceElapsedMs)}ms · noise ${noiseFloor.toFixed(3)} · voice ${voiceFloor.toFixed(3)}`);
      return;
    }

    const suggestedThreshold = clampNumber(noiseFloor + Math.max(0.035, separation * 0.45), 0.08, 0.32);
    vadOverrideRef.current = {
      speechThreshold: suggestedThreshold,
      noiseMultiplier: 1.25,
      noiseMargin: 0.02,
    };
    micCalibrationPhaseRef.current = "complete";
    setMicCalibration({
      phase: "complete",
      noiseFloor,
      voiceFloor,
      voicePeak,
      suggestedThreshold,
      message: "보정 완료. 다음 Realtime 연결의 오디오 미터 진단부터 적용됩니다.",
    });
    appendDebugLog("operator", `Mic calibration complete · voice window ${Math.round(voiceElapsedMs)}ms · meter threshold ${suggestedThreshold.toFixed(3)} · applies next Realtime connection`);
  }, [appendDebugLog]);

  const startMicCalibration = useCallback(() => {
    if (micPausedRef.current) {
      setMicCalibration((previous) => ({ ...previous, phase: "error", message: "먼저 마이크 일시정지를 해제해주세요." }));
      appendDebugLog("operator", "Mic calibration blocked while microphone is paused");
      return;
    }
    if (!realtimeStopRef.current || micCalibrationPhaseRef.current === "noise" || micCalibrationPhaseRef.current === "voice") {
      if (!realtimeStopRef.current) {
        setMicCalibration((previous) => ({ ...previous, phase: "error", message: "활성 Realtime 연결이 있을 때 보정을 시작할 수 있습니다." }));
        appendDebugLog("operator", "Mic calibration blocked · Realtime is not connected");
      }
      return;
    }

    calibrationNoiseLevelsRef.current = [];
    calibrationVoiceLevelsRef.current = [];
    const runId = micCalibrationRunRef.current + 1;
    micCalibrationRunRef.current = runId;
    micCalibrationPhaseRef.current = "noise";
    const noiseStartedAt = performance.now();
    micCalibrationPhaseStartedAtRef.current = noiseStartedAt;
    micCalibrationDeadlineRef.current = noiseStartedAt + MIC_CALIBRATION_PHASE_MS;
    setMicCalibration({ ...INITIAL_MIC_CALIBRATION, phase: "noise", message: `${MIC_CALIBRATION_PHASE_MS / 1000}초간 주변 소음을 측정합니다. 조용히 있어주세요.` });
    appendDebugLog("operator", `Mic calibration started · noise window ${MIC_CALIBRATION_PHASE_MS}ms`);

    const beginVoicePhase = () => {
      if (runId !== micCalibrationRunRef.current || micCalibrationPhaseRef.current !== "noise") return;
      const remainingMs = micCalibrationDeadlineRef.current - performance.now();
      if (remainingMs > 0) {
        micCalibrationTimerRef.current = window.setTimeout(beginVoicePhase, Math.ceil(remainingMs) + 20);
        return;
      }
      const voiceStartedAt = performance.now();
      micCalibrationPhaseRef.current = "voice";
      micCalibrationPhaseStartedAtRef.current = voiceStartedAt;
      micCalibrationDeadlineRef.current = voiceStartedAt + MIC_CALIBRATION_PHASE_MS;
      setMicCalibration((previous) => ({ ...previous, phase: "voice", message: `이제 마이크에 대고 ${MIC_CALIBRATION_PHASE_MS / 1000}초 동안 계속 말해주세요.` }));
      appendDebugLog("operator", `Mic calibration · voice window started ${MIC_CALIBRATION_PHASE_MS}ms`);
      micCalibrationTimerRef.current = window.setTimeout(() => finishMicCalibration(runId), MIC_CALIBRATION_PHASE_MS);
    };
    micCalibrationTimerRef.current = window.setTimeout(beginVoicePhase, MIC_CALIBRATION_PHASE_MS);
  }, [appendDebugLog, finishMicCalibration]);

  const resetMicCalibration = useCallback(() => {
    if (micCalibrationTimerRef.current) window.clearTimeout(micCalibrationTimerRef.current);
    micCalibrationTimerRef.current = null;
    micCalibrationRunRef.current += 1;
    micCalibrationDeadlineRef.current = 0;
    micCalibrationPhaseStartedAtRef.current = 0;
    calibrationNoiseLevelsRef.current = [];
    calibrationVoiceLevelsRef.current = [];
    micCalibrationPhaseRef.current = "idle";
    vadOverrideRef.current = {};
    setMicCalibration(INITIAL_MIC_CALIBRATION);
    appendDebugLog("operator", "Mic tuning restored to default");
  }, [appendDebugLog]);

  const toggleRequestLock = useCallback(() => {
    const next = !requestLockEnabledRef.current;
    requestLockEnabledRef.current = next;
    setRequestLockEnabled(next);
    appendDebugLog("operator", `Request speech lock ${next ? "enabled" : "disabled"} · applies to the next completed request`);
  }, [appendDebugLog]);

  const resetCounter = useCallback(async (): Promise<string> => {
    if (MOCK) {
      setRuntime((previous) => ({ ...(previous ?? MOCK_RUNTIME_STATUS), counter: 0 }));
      appendDebugLog("operator", "Mock Soma counter reset locally · API bypassed");
      return "Counter reset to Soma 001 (mock)";
    }
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
    if (normalized === "request lock on" || normalized === "speech lock on" || normalized === "발화 잠금 켜기") {
      if (!requestLockEnabledRef.current) toggleRequestLock();
      return "Request speech lock enabled";
    }
    if (normalized === "request lock off" || normalized === "speech lock off" || normalized === "발화 잠금 끄기") {
      if (requestLockEnabledRef.current) toggleRequestLock();
      return "Request speech lock disabled";
    }
    if (normalized === "request lock status" || normalized === "speech lock status") {
      return requestLockEnabledRef.current ? `Request speech lock ON${requestTurnLockedRef.current ? " · current request frozen" : ""}` : "Request speech lock OFF";
    }
    if (normalized === "counter status") return `Counter Soma ${String(runtime?.counter ?? 0).padStart(3, "0")}`;
    if (normalized === "counter reset") return "Confirmation required: /counter reset confirm";
    if (normalized === "counter reset confirm") return resetCounter();
    appendDebugLog("operator", `Unknown command: ${command.trim() || "(empty)"}`);
    return "Unknown command. Try the quick controls or /counter reset confirm";
  }, [appendDebugLog, pauseMic, resetCounter, resumeMic, runtime?.counter, toggleRequestLock]);

  const handleAudioLevel = useCallback((level: number) => {
    setMicLevel(level);
    if (micCalibrationPhaseRef.current === "noise") calibrationNoiseLevelsRef.current.push(level);
    if (micCalibrationPhaseRef.current === "voice") calibrationVoiceLevelsRef.current.push(level);
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
    playSound("analyzing");
    setResult(null);
    setLoadingLocked(false);
    setTranscript(cleanText);
    const started = Date.now();
    const askForRequestAgain = () => {
      analysisStartedRef.current = false;
      partialRef.current = "";
      requestRef.current = "";
      requestTurnLockedRef.current = false;
      setRequestTurnLocked(false);
      setRequestText("");
      setTranscript("");
      setRequestNotice("죄송합니다.\n다시 말씀해주세요.");
      setPhase("request-listen");
      appendDebugLog("analysis", "Request could not be routed; asking visitor to repeat");
      void requestRetryRef.current?.();
    };
    try {
      const sessionId = sessionIdRef.current || crypto.randomUUID();
      let nextResult: AnalysisResult;
      if (MOCK) {
        nextResult = mockAnalyzeLocally(cleanText, sessionId);
        appendDebugLog("analysis", "Mock analysis completed locally · API bypassed");
      } else {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, transcript: cleanText, startedAt: sessionStartedAtRef.current || new Date().toISOString() }),
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
        nextResult = await response.json() as AnalysisResult;
      }
      if (nextResult.matchedRule === "fallback") {
        askForRequestAgain();
        return;
      }
      setResult(nextResult);
      const elapsed = Date.now() - started;
      const revealDelay = Math.max(0, ROBOT_LOADING_DURATION_MS - elapsed - ROBOT_CARD_SETTLE_MS);
      loadingRevealTimerRef.current = window.setTimeout(() => {
        loadingRevealTimerRef.current = null;
        setLoadingLocked(true);
        loadingResultTimerRef.current = window.setTimeout(() => {
          loadingResultTimerRef.current = null;
          setPhase("result");
        }, ROBOT_CARD_SETTLE_MS);
      }, revealDelay);
    } catch (cause) {
      // Unlike askForRequestAgain (the "unroutable" path above), this was
      // never resetting the guard — a genuine network/API error here would
      // otherwise permanently block all further analysis attempts for the
      // rest of the visitor's session.
      analysisStartedRef.current = false;
      showError(cause instanceof Error ? cause.message : "분석에 실패했습니다.");
    }
  }, [appendDebugLog, playSound, showError, stopRealtime]);

  useEffect(() => {
    if (phase !== "result" || !result) return undefined;
    setResultPhotoStage("card");
    if (MOCK && mockPhotoWavePendingRef.current) {
      mockPhotoWavePendingRef.current = false;
      resultStageTimerRef.current = window.setTimeout(() => {
        resultStageTimerRef.current = null;
        startPhotoFlow();
      }, 1100);
      return () => {
        if (resultStageTimerRef.current) window.clearTimeout(resultStageTimerRef.current);
        resultStageTimerRef.current = null;
      };
    }
    resultStageTimerRef.current = window.setTimeout(() => {
      resultStageTimerRef.current = null;
      setResultPhotoStage("greeting");
      appendDebugLog("photo", "Result card ready · waiting for a hand wave");
    }, RESULT_GREETING_DELAY_MS);
    return () => {
      if (resultStageTimerRef.current) window.clearTimeout(resultStageTimerRef.current);
      resultStageTimerRef.current = null;
    };
  }, [appendDebugLog, phase, result]);

  const startPhotoFlow = useCallback((reason: string = "Hand wave detected") => {
    if (phase !== "result" || resultPhotoStage === "photo-onboarding" || resultPhotoStage === "photo-capture") return;
    if (resultStageTimerRef.current) window.clearTimeout(resultStageTimerRef.current);
    resultStageTimerRef.current = null;
    setResultPhotoStage("photo-onboarding");
    appendDebugLog("photo", `${reason} · showing photo instructions`);
    resultStageTimerRef.current = window.setTimeout(() => {
      resultStageTimerRef.current = window.setTimeout(() => {
        resultStageTimerRef.current = null;
        appendDebugLog("photo", "Photo capture complete · resetting visitor");
        resetToIdle();
      }, PHOTO_CAPTURE_MS);
      setResultPhotoStage("photo-capture");
      appendDebugLog("photo", `Photo capture started · ${Math.round(PHOTO_CAPTURE_MS / 1000)} seconds`);
    }, PHOTO_ONBOARDING_MS);
  }, [appendDebugLog, phase, resetToIdle, resultPhotoStage]);

  const handleHandWave = useCallback(() => {
    if (phase !== "result" || resultPhotoStage !== "greeting") return;
    startPhotoFlow("Hand wave detected");
  }, [phase, resultPhotoStage, startPhotoFlow]);

  // Voice-trigger counterpart to the camera hand-wave: listens for a spoken
  // "안녕"/"안녕하세요" while the greeting card is showing, via the same
  // Realtime semantic session used for wake-word listening.
  const checkGreetingText = useCallback((text: string) => {
    if (greetingHandledRef.current || !containsGreeting(text)) return;
    greetingHandledRef.current = true;
    appendDebugLog("greeting", `Spoken greeting detected: ${text.trim()}`);
    startPhotoFlow("Spoken greeting detected");
  }, [appendDebugLog, startPhotoFlow]);

  const handleGreetingDelta = useCallback((delta: string) => {
    greetingPartialRef.current += delta;
    checkGreetingText(greetingPartialRef.current);
  }, [checkGreetingText]);

  const handleGreetingCompleted = useCallback((completed: string) => {
    checkGreetingText(completed);
    greetingPartialRef.current = "";
  }, [checkGreetingText]);

  // See GREETING_TIMEOUT_MS — guarantees the greeting card always moves on
  // even if the hand-wave/voice-greeting triggers above never fire.
  useEffect(() => {
    if (phase !== "result" || resultPhotoStage !== "greeting") return undefined;
    const timer = window.setTimeout(() => {
      appendDebugLog("photo", "No wave or greeting heard within timeout · continuing automatically");
      startPhotoFlow("Greeting timeout");
    }, GREETING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [appendDebugLog, phase, resultPhotoStage, startPhotoFlow]);

  const markWake = useCallback((remainder: string) => {
    if (wakeDetectedRef.current) return;
    wakeDetectedRef.current = true;
    if (wakeHintTimerRef.current) window.clearTimeout(wakeHintTimerRef.current);
    wakeHintTimerRef.current = null;
    setWakeDetected(true);
    setWakePromptAttention(false);
    setRequestNotice("");
    setRequestPromptVisible(true);
    playSoundOnce("eidos", eidosSoundPlayedRef);
    appendDebugLog("wakeword", `Eidos detected${remainder ? ` · request: ${remainder}` : ""}`);
    setPhase("request-listen");
    window.clearTimeout(wakeTimeoutRef.current ?? undefined);
    scheduleRequestTimeout();
    if (remainder) {
      requestRef.current = remainder;
      setRequestText(remainder);
    }
  }, [appendDebugLog, playSoundOnce, scheduleRequestTimeout]);

  const handleTranscriptDelta = useCallback((delta: string) => {
    if (micCalibrationPhaseRef.current === "noise" || micCalibrationPhaseRef.current === "voice") return;
    if (requestTurnLockedRef.current) return;
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
    if (micCalibrationPhaseRef.current === "noise" || micCalibrationPhaseRef.current === "voice") return;
    if (requestTurnLockedRef.current) {
      appendDebugLog("transcribe", `Ignored completed turn while speech lock is active: ${completed}`);
      return;
    }
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
    if (nextText) playSoundOnce("request", requestSoundPlayedRef);
    requestRef.current = nextText;
    setRequestText(nextText);
    if (requestTimerRef.current) window.clearTimeout(requestTimerRef.current);
    requestTimerRef.current = nextText
      ? window.setTimeout(() => void submitAnalysis(requestRef.current), REQUEST_FINALIZE_DELAY_MS)
      : null;
    if (nextText && requestLockEnabledRef.current) {
      requestTurnLockedRef.current = true;
      setRequestTurnLocked(true);
      appendDebugLog("operator", "Request speech lock engaged · first completed request frozen");
      stopRealtimeConnection();
    }
  }, [appendDebugLog, markWake, playSoundOnce, stopRealtimeConnection, submitAnalysis]);

  const startRequestRetry = useCallback(async () => {
    if (MOCK) {
      setRealtimeStatus("mock: retry listening");
      scheduleRequestTimeout();
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
        onMicrophoneDevices: handleMicrophoneDevices,
        onVad: handleVadSnapshot,
        onTurnDetection: handleTurnDetection,
      }, { signal: abortController.signal, vad: vadOverrideRef.current, audioDeviceId: microphoneDeviceId });
      if (attempt !== realtimeAttemptRef.current || abortController.signal.aborted) {
        stop();
        return;
      }
      realtimeStopRef.current = stop;
      if (micPausedRef.current) {
        stop.pause();
        setRealtimeStatus("paused by operator");
      }
      scheduleRequestTimeout();
    } catch (cause) {
      if (attempt !== realtimeAttemptRef.current || cause instanceof RealtimeConnectionCancelledError || abortController.signal.aborted) return;
      showError(cause instanceof Error ? cause.message : "마이크 연결에 실패했습니다.");
    } finally {
      if (realtimeAttemptRef.current === attempt) realtimeAbortRef.current = null;
    }
  }, [appendDebugLog, handleAudioLevel, handleMicrophoneDevices, handleTranscriptCompleted, handleTranscriptDelta, handleTurnDetection, handleVadSnapshot, microphoneDeviceId, scheduleRequestTimeout, showError]);

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
    requestTurnLockedRef.current = false;
    analysisStartedRef.current = false;
    transcriptionLoggedRef.current = false;
    requestSoundPlayedRef.current = false;
    eidosSoundPlayedRef.current = false;
    setWakeDetected(false);
    setWakePromptAttention(false);
    setRequestPromptVisible(false);
    setRequestNotice("");
    setMicLevel(0);
    setRequestTurnLocked(false);
    setVadSnapshot(null);
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
      wakeTimeoutRef.current = window.setTimeout(handleWakeTimeout, 20000);
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
        onMicrophoneDevices: handleMicrophoneDevices,
        onVad: handleVadSnapshot,
        onTurnDetection: handleTurnDetection,
      }, { signal: abortController.signal, vad: vadOverrideRef.current, audioDeviceId: microphoneDeviceId });
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
          wakeTimeoutRef.current = window.setTimeout(handleWakeTimeout, 20000);
        }
      }
    } catch (cause) {
      if (attempt !== realtimeAttemptRef.current || cause instanceof RealtimeConnectionCancelledError || abortController.signal.aborted) return;
      showError(cause instanceof Error ? cause.message : "마이크 연결에 실패했습니다.");
    } finally {
      if (realtimeAttemptRef.current === attempt) realtimeAbortRef.current = null;
    }
  }, [appendDebugLog, handleAudioLevel, handleMicrophoneDevices, handleTranscriptCompleted, handleTranscriptDelta, handleTurnDetection, handleVadSnapshot, handleWakeTimeout, microphoneDeviceId, phase, showError]);

  const startGreetingListen = useCallback(async () => {
    if (MOCK) return; // Mock testing uses the "Wave with open hand" control instead of a live mic.
    const attempt = realtimeAttemptRef.current + 1;
    realtimeAttemptRef.current = attempt;
    const abortController = new AbortController();
    realtimeAbortRef.current = abortController;
    appendDebugLog("state", "Greeting card shown · listening for hand wave or spoken greeting");
    try {
      const stop = await startRealtimeTranscription({
        onDelta: handleGreetingDelta,
        onCompleted: handleGreetingCompleted,
        onStatus: (status, detail) => {
          const nextStatus = detail ? `${status}: ${detail}` : status;
          setRealtimeStatus(nextStatus);
          appendDebugLog("realtime", nextStatus);
        },
        onAudioLevel: handleAudioLevel,
        onMicrophoneDevices: handleMicrophoneDevices,
        onVad: handleVadSnapshot,
        onTurnDetection: handleTurnDetection,
      }, { signal: abortController.signal, vad: vadOverrideRef.current, audioDeviceId: microphoneDeviceId });
      if (attempt !== realtimeAttemptRef.current || abortController.signal.aborted) {
        stop();
        return;
      }
      realtimeStopRef.current = stop;
    } catch (cause) {
      if (attempt !== realtimeAttemptRef.current || cause instanceof RealtimeConnectionCancelledError || abortController.signal.aborted) return;
      appendDebugLog("realtime", `Greeting mic failed to start: ${cause instanceof Error ? cause.message : "unknown error"}`);
    } finally {
      if (realtimeAttemptRef.current === attempt) realtimeAbortRef.current = null;
    }
  }, [appendDebugLog, handleAudioLevel, handleGreetingCompleted, handleGreetingDelta, handleMicrophoneDevices, handleTurnDetection, handleVadSnapshot, microphoneDeviceId]);

  useEffect(() => {
    if (MOCK || phase !== "result" || resultPhotoStage !== "greeting") return undefined;
    greetingHandledRef.current = false;
    greetingPartialRef.current = "";
    void startGreetingListen();
    return () => { stopRealtimeConnection(); };
  }, [phase, resultPhotoStage, startGreetingListen, stopRealtimeConnection]);

  const handlePresenceStatus = useCallback((status: string) => {
    setPresenceStatus(status);
    appendDebugLog("camera", status);
  }, [appendDebugLog]);

  const handleCameraDevices = useCallback((devices: CameraDevice[]) => {
    setCameraDevices(devices);
    setCameraDeviceId((current) => {
      if (current && devices.some((device) => device.deviceId === current)) return current;
      const external = devices.find((device) => /logitech|brio|c920|c922|c930|streamcam|usb|external/i.test(device.label));
      return external?.deviceId ?? current;
    });
  }, []);

  const handleCameraDeviceChange = useCallback((deviceId: string) => {
    setCameraDeviceId(deviceId);
    appendDebugLog("camera", deviceId ? "Switching to selected camera" : "Using automatic camera selection");
  }, [appendDebugLog]);

  const handleFaceTelemetry = useCallback((telemetry: FaceTelemetry) => {
    setFaceTelemetry(telemetry);
    faceActiveRef.current = telemetry.active;
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
        introRevealTimerRef.current = window.setTimeout(() => setIntroRevealed(true), INTRO_REVEAL_DELAY_MS);
      }
      return;
    }
    if (micCalibrationPhaseRef.current === "noise" || micCalibrationPhaseRef.current === "voice") {
      // Calibration is an operator-owned two-phase measurement. Do not let
      // a transient face-detector miss cancel either measurement window.
      appendDebugLog("operator", "Face presence lost during mic calibration · keeping measurement active");
      return;
    }
    if (phase === "result" || phase === "error" || phase === "wait-for-exit") resetToIdle();
    else if (phase !== "idle" && phase !== "boot") resetToIdle();
  }, [appendDebugLog, phase, resetToIdle, startSession]);

  useEffect(() => {
    if (MOCK) {
      setRuntime(MOCK_RUNTIME_STATUS);
      setPhase("idle");
      appendDebugLog("runtime", "Ready · local mock runtime · API bypassed");
      return;
    }
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

  // Per-robot photo-card position/size — tuned and saved from ?gallery
  // (StateGallery); loaded once here so the real result screen picks up
  // whatever was last saved, without a rebuild. Static config, unrelated to
  // mock/live mode, so this always hits the real endpoint.
  useEffect(() => {
    fetch("/api/robot-card-offsets").then((response) => (response.ok ? response.json() as Promise<{ offsets?: RobotCardOffsets }> : null)).then((data) => {
      if (data?.offsets && Object.keys(data.offsets).length) setRobotCardOffsets((previous) => ({ ...previous, ...data.offsets }));
    }).catch(() => {
      // Keep the built-in defaults — this is a cosmetic tuning file, not critical.
    });
  }, []);

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
    if (!operatorOpen || MOCK) {
      if (MOCK) setOperatorSessions([]);
      return;
    }
    fetch("/api/operator/sessions")
      .then((response) => response.json())
      .then((sessions: Array<Record<string, unknown>>) => setOperatorSessions(sessions))
      .catch(() => setOperatorSessions([]));
  }, [operatorOpen, phase]);

  const mockWake = () => markWake("");
  const mockPreviewTranscription = useCallback(() => {
    stopRealtime();
    analysisStartedRef.current = false;
    partialRef.current = "";
    requestRef.current = "";
    requestTurnLockedRef.current = false;
    transcriptionLoggedRef.current = false;
    requestSoundPlayedRef.current = false;
    wakeDetectedRef.current = true;
    setWakeDetected(true);
    setWakePromptAttention(false);
    setRequestPromptVisible(false);
    setRequestNotice("");
    setRequestTurnLocked(false);
    setResult(null);
    setLoadingLocked(false);
    setError("");
    setTranscript("");
    setRequestText("");
    setMicLevel(0);
    setPhase("request-listen");
    setRealtimeStatus("mock: previewing transcription");
    appendDebugLog("transcribe", "Mock transcription preview started");

    const words = MOCK_TRANSCRIPTION_TEXT.split(/\s+/);
    let revealed = 0;
    const revealNextWord = () => {
      revealed += 1;
      playSoundOnce("request", requestSoundPlayedRef);
      const nextText = words.slice(0, revealed).join(" ");
      partialRef.current = nextText;
      requestRef.current = nextText;
      setTranscript(nextText);
      setRequestText(nextText);
      if (revealed < words.length) {
        mockTranscriptionTimerRef.current = window.setTimeout(revealNextWord, MOCK_TRANSCRIPTION_STEP_MS);
      } else {
        mockTranscriptionTimerRef.current = null;
        playSoundOnce("request", requestSoundPlayedRef);
        setRealtimeStatus("mock: transcription preview ready");
        appendDebugLog("transcribe", `Mock preview completed: ${MOCK_TRANSCRIPTION_TEXT}`);
      }
    };
    mockTranscriptionTimerRef.current = window.setTimeout(revealNextWord, MOCK_TRANSCRIPTION_STEP_MS);
  }, [appendDebugLog, playSoundOnce, stopRealtime]);
  const mockAnalyze = () => void submitAnalysis(mockRequest);
  const mockAnalyzeFail = () => void submitAnalysis(MOCK_UNROUTABLE_TEXT);
  const mockPhotoWave = useCallback(() => {
    if (phase !== "result" || !result) {
      mockPhotoWavePendingRef.current = true;
      if (phase !== "analyzing") void submitAnalysis(mockRequest);
      return;
    }
    if (resultPhotoStage === "photo-onboarding" || resultPhotoStage === "photo-capture") return;
    // The mock control bypasses the greeting wait and starts the same photo
    // flow as a live open-palm wave, even while the card is still in `card`.
    startPhotoFlow();
  }, [mockRequest, phase, result, resultPhotoStage, startPhotoFlow, submitAnalysis]);
  const introIntensity = introVisualIntensity(phase, faceTelemetry.stableMs, faceTelemetry.active);
  // Visitors naturally stand farther back to frame themselves (and anyone
  // joining them) for the photo, which shrinks their face in the camera
  // frame — loosen the area threshold and give a longer absence grace
  // period so that doesn't get misread as "visitor left" and reset to idle.
  const photoOnboardingActive = phase === "result" && resultPhotoStage === "photo-onboarding";
  // Once the capture countdown is actually running, though, a face that's
  // genuinely out of frame means the photo itself would be pointless — give
  // it only a brief grace window, then reset.
  const photoCaptureActive = phase === "result" && resultPhotoStage === "photo-capture";
  const photoStageActive = photoOnboardingActive || photoCaptureActive;

  if (GALLERY) return <StateGallery selectedRobotId={galleryRobotId} onSelectRobot={setGalleryRobotId} />;

  return (
    <main className={`kiosk kiosk-${phase} ${operatorOpen ? "kiosk-debug" : ""} ${screenRotated ? "kiosk-screen-rotated" : ""}`}>
      {resetFadeKey > 0 && <div key={resetFadeKey} className="reset-fade" aria-hidden="true" />}
      <PresenceDetector mock={MOCK} enabled={phase !== "boot"} diagnostic={(operatorOpen || MOCK) && !photoStageActive} resetToken={presenceResetToken} cameraDeviceId={cameraDeviceId} handDetectionEnabled={MOCK || phase === "analyzing" || phase === "result"} handWaveEnabled={phase === "result" && resultPhotoStage === "greeting"} minFaceAreaRatio={photoStageActive ? 0.01 : undefined} presenceAbsentMs={photoCaptureActive ? 3000 : photoOnboardingActive ? 8000 : undefined} onPresence={handlePresence} onHandWave={handleHandWave} onStatus={handlePresenceStatus} onTelemetry={handleFaceTelemetry} onDevices={handleCameraDevices} onStream={setCameraStream} />
      {phase === "boot" && <section className="screen screen-center"><p className="eyebrow">EIDOS</p><h1>Preparing the experience</h1></section>}
      {(phase === "idle" || phase === "presence" || phase === "realtime-connecting" || phase === "wake-listen" || phase === "request-listen") && <WelcomeScreen mode={phase === "request-listen" ? "request" : "prompt"} visualState={phase} initial={phase === "idle"} ready={introRevealed && phase === "wake-listen"} intensity={introIntensity} wakePromptAttention={phase === "wake-listen" && wakePromptAttention} requestPromptVisible={requestPromptVisible} requestNotice={phase === "request-listen" ? requestNotice : ""} requestText={requestText} micLevel={phase === "wake-listen" || phase === "request-listen" ? micLevel : 0} exampleMorphTrigger={exampleMorphTrigger} />}
      {phase === "analyzing" && <RobotLoadingScreen locked={loadingLocked} robotId={result?.robotId ?? null} />}
      {phase === "result" && result && <ResultScreen result={result} photoStage={resultPhotoStage} cameraStream={cameraStream} mock={MOCK} robotCardOffset={robotCardOffsetFor(robotCardOffsets, result.robotId)} />}

      {MOCK && <MockPanel
        mockRequest={mockRequest}
        onMockRequestChange={setMockRequest}
        onWake={mockWake}
        onPreviewTranscription={mockPreviewTranscription}
        onAnalyze={mockAnalyze}
        onAnalyzeFail={mockAnalyzeFail}
        onReset={() => resetToIdle()}
        onGallery={() => window.location.assign("?mock&gallery")}
        onPhotoWave={mockPhotoWave}
        requestPromptVisible={requestPromptVisible}
        onRequestPromptVisibleChange={setRequestPromptVisible}
        onPreviewExampleMorph={() => setExampleMorphTrigger((value) => value + 1)}
        status={`${phase} · ${runtime?.counter ?? 0} · ${presenceStatus} · ${realtimeStatus}`}
      />}

      {operatorOpen && <DiagnosticPanel phase={phase} runtime={runtime} presenceStatus={presenceStatus} realtimeStatus={realtimeStatus} turnDetectionMode={turnDetectionMode} faceTelemetry={faceTelemetry} micLevel={micLevel} micPaused={micPaused} vadSnapshot={vadSnapshot} micCalibration={micCalibration} requestLockEnabled={requestLockEnabled} requestTurnLocked={requestTurnLocked} wakeDetected={wakeDetected} transcript={transcript} requestText={requestText} logs={debugLogs} sessions={operatorSessions} cameraDevices={cameraDevices} cameraDeviceId={cameraDeviceId} onCameraDeviceChange={handleCameraDeviceChange} microphoneDevices={microphoneDevices} microphoneDeviceId={microphoneDeviceId} activeMicrophoneDeviceId={activeMicrophoneDeviceId} onMicrophoneDeviceChange={handleMicrophoneDeviceChange} screenRotated={screenRotated} onToggleScreenRotation={() => setScreenRotated((value) => !value)} onClose={() => setOperatorOpen(false)} onReset={resetToIdle} onExport={() => downloadSessions(operatorSessions)} onGallery={() => window.location.assign("?mock&gallery")} onCommand={handleOperatorCommand} onCounterReset={resetCounter} onToggleRequestLock={toggleRequestLock} onStartMicCalibration={startMicCalibration} onResetMicCalibration={resetMicCalibration} />}
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
  turnDetectionMode,
  faceTelemetry,
  micLevel,
  micPaused,
  vadSnapshot,
  micCalibration,
  requestLockEnabled,
  requestTurnLocked,
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
  onToggleRequestLock,
  onStartMicCalibration,
  onResetMicCalibration,
  screenRotated,
  onToggleScreenRotation,
  cameraDevices,
  cameraDeviceId,
  onCameraDeviceChange,
  microphoneDevices,
  microphoneDeviceId,
  activeMicrophoneDeviceId,
  onMicrophoneDeviceChange,
}: {
  phase: KioskPhase;
  runtime: RuntimeStatus | null;
  presenceStatus: string;
  realtimeStatus: string;
  turnDetectionMode: "unknown" | "semantic_vad";
  faceTelemetry: FaceTelemetry;
  micLevel: number;
  micPaused: boolean;
  vadSnapshot: VadSnapshot | null;
  micCalibration: MicCalibrationState;
  requestLockEnabled: boolean;
  requestTurnLocked: boolean;
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
  onToggleRequestLock: () => void;
  onStartMicCalibration: () => void;
  onResetMicCalibration: () => void;
  screenRotated: boolean;
  onToggleScreenRotation: () => void;
  cameraDevices: CameraDevice[];
  cameraDeviceId: string;
  onCameraDeviceChange: (deviceId: string) => void;
  microphoneDevices: MicrophoneDevice[];
  microphoneDeviceId: string;
  activeMicrophoneDeviceId: string;
  onMicrophoneDeviceChange: (deviceId: string) => void;
}) {
  const signalPercent = Math.round(Math.min(1, micLevel) * 100);
  const activeMicrophoneLabel = microphoneDevices.find((device) => device.deviceId === activeMicrophoneDeviceId)?.label ?? (activeMicrophoneDeviceId ? "Active microphone" : "not connected");
  const turnDetectionLabel = turnDetectionMode === "unknown"
    ? "pending"
    : `semantic_vad · medium${wakeDetected || phase === "request-listen" ? " · request" : ""}`;
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
  return <aside className="diagnostic-panel" aria-label="Eidos development monitor"><div className="diagnostic-panel-content">
    <div className="diagnostic-header"><div><strong>EIDOS DEV MONITOR</strong><span>Live camera · microphone · transcription</span></div><div className="diagnostic-header-actions"><button type="button" onClick={onToggleScreenRotation} aria-pressed={screenRotated}>{screenRotated ? "Reset 0°" : "Rotate 90°"}</button><button type="button" onClick={onClose}>Hide</button></div></div>

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
      <label className="diagnostic-device-select">Camera device<select value={cameraDeviceId} onChange={(event) => onCameraDeviceChange(event.target.value)}><option value="">Auto · external preferred</option>{cameraDevices.map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></label>
      <div className="diagnostic-grid"><span>Faces <b>{faceTelemetry.faceCount}</b></span><span>Confidence <b>{faceTelemetry.confidence.toFixed(2)}</b></span><span>Area <b>{(faceTelemetry.areaRatio * 100).toFixed(1)}%</b></span><span>Stable <b>{(faceTelemetry.stableMs / 1000).toFixed(1)}s</b></span><span>Absent <b>{(faceTelemetry.absentMs / 1000).toFixed(1)}s</b></span></div>
      <small className="diagnostic-muted">threshold: confidence ≥ .65 · area ≥ 2.0% · stable ≥ .5s<br />{presenceStatus} · last frame {faceTelemetry.lastFrameAt}</small>
    </section>

    <section className="diagnostic-section">
      <div className="diagnostic-kicker">HAND WAVE / HOLD</div>
      <div className="diagnostic-row"><span>Palm</span><strong className={faceTelemetry.hand?.open ? "status-good" : "status-idle"}>{faceTelemetry.hand ? (faceTelemetry.hand.open ? "OPEN" : "not open") : "no hand"}</strong></div>
      <div className="diagnostic-grid"><span>Palm width <b>{(faceTelemetry.hand?.palmWidth ?? 0).toFixed(3)}</b></span><span>Held <b>{((faceTelemetry.hand?.heldMs ?? 0) / 1000).toFixed(1)}s / 5.0s</b></span><span>Span <b>{(faceTelemetry.hand?.span ?? 0).toFixed(3)}</b></span><span>Travelled <b>{(faceTelemetry.hand?.travelled ?? 0).toFixed(3)}</b></span><span>Dir. changes <b>{faceTelemetry.hand?.directionChanges ?? 0}</b></span></div>
      <small className="diagnostic-muted">threshold: palm width ≥ .012 · hold ≥ 5.0s OR (span ≥ .11 · travelled ≥ .2 · dir. changes ≥ 1)</small>
    </section>

    <section className="diagnostic-section">
      <div className="diagnostic-kicker">MICROPHONE / REALTIME</div>
      <div className="diagnostic-row"><span>Realtime</span><strong className={realtimeStatus.startsWith("connected") ? "status-good" : "status-idle"}>{realtimeStatus}</strong></div>
      <div className="diagnostic-row"><span>Realtime model</span><strong>{runtime?.models.realtime ?? "gpt-realtime-2.1-mini"}</strong></div>
      <div className="diagnostic-row"><span>Transcription</span><strong>{runtime?.models.transcription ?? "gpt-live-transcribe"}</strong></div>
      <div className="diagnostic-row"><span>Turn detection</span><strong>{turnDetectionLabel}</strong></div>
      <label className="diagnostic-device-select">Microphone input<select value={microphoneDeviceId} onChange={(event) => onMicrophoneDeviceChange(event.target.value)}><option value="">Auto · system/browser default</option>{microphoneDeviceId && !microphoneDevices.some((device) => device.deviceId === microphoneDeviceId) && <option value={microphoneDeviceId}>Saved microphone · currently unavailable</option>}{microphoneDevices.map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></label>
      <div className="diagnostic-row"><span>Active input</span><strong className={activeMicrophoneDeviceId ? "status-good" : "status-idle"}>{activeMicrophoneLabel}</strong></div>
      <small className="diagnostic-muted">Selection is saved on this Mac and applies from the next Realtime connection.</small>
      <div className="mic-meter"><span style={{ width: `${signalPercent}%` }} /></div>
      <div className="diagnostic-row"><span>Input level</span><strong className={signalPercent > 1 ? "status-good" : "status-idle"}>{signalPercent}% · {signalPercent > 1 ? "signal received" : "silence / waiting"}</strong></div>
      <div className="diagnostic-grid"><span>Noise floor <b>{vadSnapshot ? vadSnapshot.noiseFloor.toFixed(3) : "—"}</b></span><span>Meter threshold <b>{vadSnapshot ? vadSnapshot.threshold.toFixed(3) : "—"}</b></span><span>Semantic turn <b className={vadSnapshot?.speechActive ? "status-good" : "status-idle"}>{vadSnapshot?.speechActive ? "SPEECH" : "quiet"}</b></span><span>Calibration <b>{vadSnapshot?.calibrated ? "ready" : "warming"}</b></span></div>
    </section>

    <section className="diagnostic-section diagnostic-experimental">
      <div className="diagnostic-kicker">FIELD TEST MODES</div>
      <div className="diagnostic-row"><span>발화 잠금</span><strong className={requestLockEnabled ? "status-good" : "status-idle"}>{requestLockEnabled ? (requestTurnLocked ? "ON · CURRENT FROZEN" : "ON") : "OFF · DEFAULT"}</strong></div>
      <div className="operator-actions">
        <button type="button" className={requestLockEnabled ? "operator-mode-on" : ""} onClick={onToggleRequestLock}>{requestLockEnabled ? "발화 잠금 끄기" : "발화 잠금 켜기"}</button>
        <button type="button" onClick={onStartMicCalibration} disabled={micCalibration.phase === "noise" || micCalibration.phase === "voice" || micPaused}>{micCalibration.phase === "noise" ? "소음 측정 중…" : micCalibration.phase === "voice" ? "테스트 발화 중…" : "마이크 재보정 시작"}</button>
      </div>
      <div className="diagnostic-grid"><span>Ambient <b>{micCalibration.noiseFloor === null ? "—" : micCalibration.noiseFloor.toFixed(3)}</b></span><span>Voice <b>{micCalibration.voiceFloor === null ? "—" : micCalibration.voiceFloor.toFixed(3)}</b></span><span>Peak <b>{micCalibration.voicePeak === null ? "—" : micCalibration.voicePeak.toFixed(3)}</b></span><span>New threshold <b>{micCalibration.suggestedThreshold === null ? "—" : micCalibration.suggestedThreshold.toFixed(3)}</b></span></div>
      <small className="diagnostic-muted">{micCalibration.message}<br />보정값은 다음 Realtime 연결의 오디오 미터 진단부터 적용되며 새로고침하면 기본값으로 돌아갑니다.</small>
      <button type="button" onClick={onResetMicCalibration}>마이크 기본값 복원</button>
    </section>

    <section className={`diagnostic-section wake-status ${wakeDetected ? "wake-detected" : ""}`}>
      <div className="diagnostic-kicker">WAKEWORD</div>
      <strong>{wakeDetected ? "✓ EIDOS DETECTED" : "Listening for Eidos"}</strong>
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
  </div></aside>;
}

function MockPanel({ mockRequest, onMockRequestChange, onWake, onPreviewTranscription, onAnalyze, onAnalyzeFail, onReset, onGallery, onPhotoWave, requestPromptVisible, onRequestPromptVisibleChange, onPreviewExampleMorph, status }: {
  mockRequest: string;
  onMockRequestChange: (value: string) => void;
  onWake: () => void;
  onPreviewTranscription: () => void;
  onAnalyze: () => void;
  onAnalyzeFail: () => void;
  onReset: () => void;
  onGallery: () => void;
  onPhotoWave: () => void;
  requestPromptVisible: boolean;
  onRequestPromptVisibleChange: (visible: boolean) => void;
  onPreviewExampleMorph: () => void;
  status: string;
}) {
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, originX: offset?.x ?? 0, originY: offset?.y ?? 0 };
  };
  const onHandlePointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!dragRef.current) return;
    setOffset({ x: dragRef.current.originX + (event.clientX - dragRef.current.startX), y: dragRef.current.originY + (event.clientY - dragRef.current.startY) });
  };
  const onHandlePointerEnd = (event: ReactPointerEvent<HTMLSpanElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <aside className={`mock-panel ${collapsed ? "mock-panel-collapsed" : ""}`} aria-label="Mock controls" style={offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}>
    <span className="mock-panel-handle" onPointerDown={onHandlePointerDown} onPointerMove={onHandlePointerMove} onPointerUp={onHandlePointerEnd} onPointerCancel={onHandlePointerEnd}>MOCK MODE ⠿⠿ drag to move</span>
    <button className="mock-panel-toggle" type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed} aria-label={collapsed ? "Expand mock controls" : "Collapse mock controls"}>{collapsed ? "+" : "−"}</button>
    {!collapsed && <>
      <div className="mock-panel-actions">
        <button type="button" onClick={onWake}>Say “Eidos”</button>
        <button type="button" onClick={onPreviewTranscription}>Preview live transcription</button>
        <button type="button" onClick={() => onRequestPromptVisibleChange(!requestPromptVisible)} aria-pressed={requestPromptVisible}>
          {requestPromptVisible ? "Hide request prompt" : "Show request prompt"}
        </button>
        <button type="button" onClick={onPreviewExampleMorph} disabled={!requestPromptVisible} title={requestPromptVisible ? undefined : "Show the request prompt first"}>Preview text morph</button>
        <button type="button" onClick={onAnalyze}>Analyze request</button>
        <button type="button" onClick={onAnalyzeFail}>Simulate unroutable request</button>
        <button type="button" onClick={onPhotoWave}>Wave with open hand</button>
        <button type="button" onClick={onReset}>Reset visitor</button>
        <button type="button" onClick={onGallery}>Open state gallery</button>
      </div>
      <input value={mockRequest} onChange={(event) => onMockRequestChange(event.target.value)} aria-label="Mock request" />
      <small>{status}</small>
    </>}
  </aside>;
}

function Orb({ active = false }: { active?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (active) void video.play().catch(() => {});
    else video.pause();
  }, [active]);
  return <div className={`orb ${active ? "orb-active" : ""}`} aria-hidden="true">
    <video ref={videoRef} loop muted playsInline preload="auto" poster="/media/eidosmotion3.png">
      <source src="/media/eidosmotion3.mp4" type="video/mp4" />
    </video>
  </div>;
}

// Row order top-to-bottom, each paired with the fixed window frame behind
// which it spins. box2 is the brighter/glowing frame, so it goes on the
// centre row to read as the "active" selection window. Each row shows
// <defaultBox> until its reel docks its final module (REEL_STOP_MS[id]),
// then crossfades to <activeBox> — see .slot-box-active in styles.css.
const REEL_ROWS: Array<{ id: "H" | "C" | "L"; defaultBox: string; activeBox: string }> = [
  { id: "H", defaultBox: "/assets/box1-default.png", activeBox: "/assets/box1.png" },
  { id: "C", defaultBox: "/assets/box2-default.png", activeBox: "/assets/box2.png" },
  { id: "L", defaultBox: "/assets/box3-default.png", activeBox: "/assets/box3.png" },
];
// How long the default -> active box crossfade itself takes, once the
// reel's module lands. Kept short and snug against the landing moment so
// the box "lighting up" reads as a direct reaction to the module docking.
const BOX_CROSSFADE_MS = 550;

// robotId is null until the analysis result resolves (it starts loading
// before the API/mock call returns). Once known, each ReelTrack pins its
// row's module per ROBOT_MODULE_MAP — see ReelTrack for how a still-random
// mount reconciles with a pin that can arrive slightly after it.
function RobotLoadingScreen({ locked, robotId }: { locked: boolean; robotId: number | null }) {
  const pins = robotId != null ? ROBOT_MODULE_MAP[robotId] : undefined;
  return <section className={`screen robot-loading ${locked ? "robot-loading-locked" : ""}`} aria-live="polite">
    <div className="slot-glow" aria-hidden="true" />
    <p className="robot-loading-headline"><TextAnimate animation="blurInUp" by="character" once className="loading-headline-text t-shimmer" data-text="Your Eidos is coming to life">Your Eidos is coming to life</TextAnimate></p>
    <div className="slot-stack" aria-label="Eidos modules spinning into place">
      {REEL_ROWS.map((row) => {
        const crossfadeStyle = { animationDelay: `${REEL_STOP_MS[row.id]}ms`, animationDuration: `${BOX_CROSSFADE_MS}ms` } as CSSProperties;
        return <div className="slot-row" key={row.id}>
          <ReelTrack rowId={row.id} pinnedName={pins?.[row.id] ?? null} />
          <img className="slot-box slot-box-default" src={row.defaultBox} alt="" aria-hidden="true" draggable={false} style={crossfadeStyle} />
          <img className="slot-box slot-box-active" src={row.activeBox} alt="" aria-hidden="true" draggable={false} style={crossfadeStyle} />
        </div>;
      })}
    </div>
  </section>;
}

/**
 * One horizontally-scrolling row of module renders. Plays a single
 * deterministic CSS animation from mount (transform-only, GPU-friendly):
 * cruise, then decelerate, then land exactly on an item boundary at
 * REEL_STOP_MS[rowId] and hold there (animation-fill-mode: forwards). Every
 * row shares the same keyframes (see @keyframes reel-run in styles.css);
 * only --reel-final (distance) and animation-duration (this row's stop
 * time) differ, which is what staggers the three rows' stops.
 *
 * The module order is reshuffled independently per row on every mount (the
 * component only mounts while phase === "analyzing", i.e. once per request),
 * so the spin still looks random. `pinnedName` (from ROBOT_MODULE_MAP, keyed
 * by the analysis result's robotId) then swaps that module into
 * REEL_LANDING_INDEX[rowId] — the one array slot that ends up centered in
 * the box — so the *landing* is deterministic while everything else about
 * the pass stays random. `pinnedName` is often still null at mount (the
 * result hasn't resolved yet), so the swap happens in an effect once it
 * arrives; it targets an index that's still off-screen at that point in the
 * run (REEL_STOP_MS is always several seconds after mount), so the swap
 * itself is never visible. If `pinnedName` isn't one of this row's known
 * modules (e.g. an asset that hasn't been added to REEL_MODULE_SETS yet),
 * it's ignored rather than injected as a broken image.
 */
function ReelTrack({ rowId, pinnedName }: { rowId: "H" | "C" | "L"; pinnedName?: string | null }) {
  const [images, setImages] = useState(() => shuffled(REEL_ROW_IMAGES[rowId]));
  const appliedPinRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pinnedName || appliedPinRef.current === pinnedName) return;
    const targetSrc = `/assets/${rowId}/${pinnedName}.png`;
    setImages((prev) => {
      const landingIndex = REEL_LANDING_INDEX[rowId];
      if (prev[landingIndex] === targetSrc) return prev;
      const pinnedIndex = prev.indexOf(targetSrc);
      if (pinnedIndex === -1) return prev; // Unknown module for this row — leave the random landing as-is.
      appliedPinRef.current = pinnedName;
      const next = [...prev];
      [next[landingIndex], next[pinnedIndex]] = [next[pinnedIndex], next[landingIndex]];
      return next;
    });
  }, [pinnedName, rowId]);
  const strip = [...images, ...images];
  const style = {
    "--reel-final": REEL_FINAL_OFFSET[rowId],
    animationDuration: `${REEL_STOP_MS[rowId]}ms`,
  } as CSSProperties;

  return <div className="reel-row">
    <div className="reel-track" style={style}>
      {strip.map((src, index) => (
        <img key={`${rowId}-${index}`} src={src} className="reel-item" alt="" draggable={false} loading={index < images.length ? "eager" : "lazy"} />
      ))}
    </div>
  </div>;
}

function ResultScreen({ result, photoStage, cameraStream, mock, robotCardOffset = ROBOT_CARD_DEFAULT_OFFSET }: { result: AnalysisResult; photoStage: ResultPhotoStage; cameraStream: MediaStream | null; mock: boolean; robotCardOffset?: RobotCardOffset }) {
  const mp4Url = result.videoUrl.replace(/\.webm$/, ".mp4");
  const posterUrl = result.videoUrl.replace(/\.webm$/, ".webp");
  const photoActive = photoStage === "photo-onboarding" || photoStage === "photo-capture";
  const cardClass = `result-card ${photoActive ? "result-card-flipped" : ""}`;
  return <section className={`screen result-screen result-screen-stage-${photoStage}`}>
    {photoActive && <PhotoCaptureAmbient stage={photoStage} />}
    <div className="result-card-wrapper">
      <article className={cardClass} aria-label={`${result.displayName} ${result.title}`}>
        <ResultCardFrontFace result={result} videoUrl={result.videoUrl} mp4Url={mp4Url} posterUrl={posterUrl} />
        <ResultCardBackFace result={result} videoUrl={result.videoUrl} mp4Url={mp4Url} posterUrl={posterUrl} active={photoActive} cameraStream={cameraStream} mock={mock} robotCardOffset={robotCardOffset} />
      </article>
    </div>
    <div className={`result-orb ${photoActive ? "result-orb-hidden" : ""}`}><Orb /></div>
    {photoStage === "greeting" && <p className="result-greeting t-shimmer" data-text="당신의 Eidos에게 인사하세요">당신의 Eidos에게 인사하세요</p>}
    {photoStage === "photo-onboarding" && <div className="photo-onboarding" role="status" aria-live="polite">
      <div className="photo-onboarding-content">
        <p className="photo-onboarding-countdown">Photo in {Math.round(PHOTO_CAPTURE_MS / 1000)} seconds</p>
        <p className="photo-onboarding-title">Eidos와 특별한 한 장을 남겨볼까요?</p>
      </div>
    </div>}
    {photoStage === "photo-capture" && <PhotoStageTimer />}
    {photoStage === "photo-capture" && <p className="photo-capture-prompt t-shimmer" data-text="Eidos와 함께하는 일상을 미리 만나보세요">Eidos와 함께하는 일상을 미리 만나보세요</p>}
  </section>;
}

/** Whole-second countdown shown above the caption during the capture window. */
function PhotoStageTimer() {
  const [remaining, setRemaining] = useState(PHOTO_CAPTURE_MS);
  useEffect(() => {
    // Wall-clock ticks rather than requestAnimationFrame: rAF is paused while
    // the page is not painting, which would freeze the readout.
    const startedAt = Date.now();
    setRemaining(PHOTO_CAPTURE_MS);
    const id = window.setInterval(() => setRemaining(Math.max(0, PHOTO_CAPTURE_MS - (Date.now() - startedAt))), 100);
    return () => window.clearInterval(id);
  }, []);
  return <div className="photo-stage-timer" role="timer" aria-live="off">{Math.ceil(remaining / 1000)}</div>;
}

function ResultCardFrontFace({ result, videoUrl, mp4Url, posterUrl }: { result: AnalysisResult; videoUrl: string; mp4Url: string; posterUrl: string }) {
  return <div className="result-card-face result-card-face-front" data-card-face="front">
    <img className="result-card-bg" src="/assets/bg.png" alt="" aria-hidden="true" />
    <div className="result-card-robot-mask">
      <video key={videoUrl} className="result-card-robot" autoPlay loop muted playsInline preload="auto" poster={posterUrl} aria-label={`${result.title} preview`}>
        <source src={videoUrl} type="video/webm" />
        <source src={mp4Url} type="video/mp4" />
      </video>
    </div>
    <ResultCardFrontDetails result={result} />
  </div>;
}

function ResultCardBackFace({ result, videoUrl, mp4Url, posterUrl, active, cameraStream, mock, robotCardOffset }: { result: AnalysisResult; videoUrl: string; mp4Url: string; posterUrl: string; active: boolean; cameraStream: MediaStream | null; mock: boolean; robotCardOffset: RobotCardOffset }) {
  const robotStyle = {
    "--robot-scale": robotCardOffset.scale,
    "--robot-top": `${robotCardOffset.top}%`,
    "--robot-left": `${robotCardOffset.left}%`,
  } as CSSProperties;
  return <div className="result-card-face result-card-face-back" data-card-face="back">
    <ResultCameraPreview active={active} cameraStream={cameraStream} mock={mock} />
    <div className="result-card-camera-dim" />
    <div className="result-card-back-robot-mask" data-robot-id={result.robotId} style={robotStyle}>
      <video key={videoUrl} className="result-card-back-robot" autoPlay loop muted playsInline preload="auto" poster={posterUrl} aria-label={`${result.title} camera companion`}>
        <source src={videoUrl} type="video/webm" />
        <source src={mp4Url} type="video/mp4" />
      </video>
    </div>
    <ResultCardBackDetails result={result} />
  </div>;
}

function ResultCardFrontDetails({ result }: { result: AnalysisResult }) {
  return <ResultCardDetails result={result} showTasks />;
}

function ResultCardBackDetails({ result }: { result: AnalysisResult }) {
  // The photo side keeps the Soma name and title, but drops the task list so
  // the live camera stays readable.
  return <ResultCardDetails result={result} showTasks={false} />;
}

// Placeholder shown when a field comes back empty (e.g. previewing the UI
// with the API disconnected) so the card never renders blank text.
const DUMMY_SOMA = "Soma 001";
const DUMMY_TITLE = "Your Eidos";
const DUMMY_TASKS = ["Assist Around Home", "Carry Light Items", "Keep You Company"];

function ResultCardDetails({ result, showTasks = true }: { result: AnalysisResult; showTasks?: boolean }) {
  const tasks = result.requiredTasks?.length ? result.requiredTasks : DUMMY_TASKS;
  return <>
    <header className="result-card-header">
      <p className="result-card-soma"><SomaDisplayName value={result.displayName || DUMMY_SOMA} /></p>
      <p className="result-card-title">{result.title || DUMMY_TITLE}</p>
    </header>
    {showTasks && <p className="result-card-tasks">
        <span className="result-card-tasks-label">Required Tasks :</span>
        <span className="result-card-tasks-value">
          {tasks.slice(0, 3).map((task, index) => (
            <span className="result-task-item" key={`${task}-${index}`}>
              {task}{index < Math.min(tasks.length, 3) - 1 ? "," : ""}
            </span>
          ))}
        </span>
      </p>}
  </>;
}

function ResultCameraPreview({ active, cameraStream, mock }: { active: boolean; cameraStream: MediaStream | null; mock: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);

  useEffect(() => {
    if (!active) {
      setCameraUnavailable(false);
      return undefined;
    }
    if (cameraStream?.active) {
      setCameraUnavailable(false);
      streamRef.current = cameraStream;
      if (videoRef.current) {
        videoRef.current.srcObject = cameraStream;
        void videoRef.current.play().catch(() => {});
      }
      return () => {
        if (videoRef.current?.srcObject === cameraStream) videoRef.current.srcObject = null;
        if (streamRef.current === cameraStream) streamRef.current = null;
      };
    }
    // PresenceDetector is the single owner of getUserMedia. Requesting a
    // second stream here can race the detector in mock mode and leave the
    // card showing a stale/empty face. If no shared stream is available,
    // show the mock fallback instead of opening another camera stream.
    setCameraUnavailable(!cameraStream?.active);
    return () => {
      if (videoRef.current?.srcObject === cameraStream) videoRef.current.srcObject = null;
      streamRef.current = null;
    };
  }, [active, cameraStream]);

  return <div className="result-camera-preview" aria-hidden="true">
    <video ref={videoRef} muted playsInline autoPlay />
    {mock && cameraUnavailable && <div className="result-camera-mock-feed" />}
  </div>;
}

function PhotoCaptureAmbient({ stage }: { stage: "photo-onboarding" | "photo-capture" }) {
  return <div className={`photo-capture-ambient ${stage === "photo-capture" ? "is-capturing" : ""}`} aria-hidden="true"><span /></div>;
}

function WelcomeScreen({ mode = "prompt", visualState = "idle", initial = false, ready = false, intensity = 0, wakePromptAttention = false, requestPromptVisible = false, requestNotice = "", requestText = "", micLevel = 0, exampleMorphTrigger = 0 }: { mode?: "prompt" | "request"; visualState?: KioskPhase; initial?: boolean; ready?: boolean; intensity?: number; wakePromptAttention?: boolean; requestPromptVisible?: boolean; requestNotice?: string; requestText?: string; micLevel?: number; exampleMorphTrigger?: number }) {
  const requestMode = mode === "request";
  const hasRequestText = Boolean(requestText.trim());
  const showRequestPrompt = requestPromptVisible && !hasRequestText && !requestNotice;
  // In wake-listen, the dock's "engaged" glow is part of the same reveal as
  // the hint text (both should wait for `ready`) — but request-listen has
  // its own already-delayed entrance, so requestMode isn't gated here.
  const imageEngaged = (visualState === "wake-listen" && ready) || requestMode;
  return <section className={`screen screen-intro ${ready ? "screen-intro-ready" : "screen-intro-idle"} screen-intro-state-${visualState} ${initial ? "screen-intro-initial" : ""} ${requestMode ? "screen-intro-request" : ""} ${wakePromptAttention ? "screen-intro-attention" : ""}`}>
    <AmbientField intensity={intensity} micLevel={micLevel} />
    <div className="intro-content" aria-hidden={requestMode}>
      <div className="intro-prompt-container">
        <PromptDock intensity={intensity} attention={imageEngaged} />
        <p className={`intro-hint ${ready ? "is-visible" : ""} ${wakePromptAttention ? "intro-hint-attention t-shimmer" : ""}`} data-text="화면을 향해 ‘Eidos’라고 말해보세요" aria-hidden={!ready}>화면을 향해 ‘Eidos’라고 말해보세요</p>
      </div>
    </div>
    <div className="listening-layout" aria-hidden={!requestMode}>
      <div className="listening-heading"><span>I'm Listening,</span><span>Tell me What You Need</span></div>
      <div className="listening-center">
        <RequestPrompt visible={showRequestPrompt} forceTick={exampleMorphTrigger} />
        <p className={`request-notice ${requestNotice && !hasRequestText ? "is-visible" : "is-hidden"}`} aria-live="polite">{requestNotice}</p>
        <AnimatedTranscript text={requestText} visible={hasRequestText} />
      </div>
      <Orb active={requestMode} />
    </div>
  </section>;
}

function randomExampleIndex() {
  return Math.floor(Math.random() * REQUEST_EXAMPLES.length);
}

/** Shows the generic instruction first, then alternates with a concrete
 *  example every REQUEST_EXAMPLE_DELAY_MS for as long as the visitor stays
 *  silent — see REQUEST_EXAMPLES. The default instruction always sits
 *  between examples (default → example → default → example → …); the
 *  first example is picked at random and each one after that steps to the
 *  next in list order, wrapping around. Morphs between lines (blur + scale
 *  + opacity) rather than cutting.
 *
 *  `forceTick` is a dev/demo hook: MockPanel's "Preview text morph" button
 *  bumps it to trigger an immediate swap without waiting out the interval,
 *  so the morph transition can be previewed on demand. */
function RequestPrompt({ visible, forceTick = 0 }: { visible: boolean; forceTick?: number }) {
  const [showExample, setShowExample] = useState(false);
  const [example, setExample] = useState(() => REQUEST_EXAMPLES[randomExampleIndex()]);
  const nextExampleIndex = useRef(randomExampleIndex());
  const advance = useCallback(() => {
    setShowExample((prev) => {
      if (!prev) {
        setExample(REQUEST_EXAMPLES[nextExampleIndex.current]);
        nextExampleIndex.current = (nextExampleIndex.current + 1) % REQUEST_EXAMPLES.length;
      }
      return !prev;
    });
  }, []);

  useEffect(() => {
    if (!visible) {
      setShowExample(false);
      // Fresh random starting point for the next time this prompt appears.
      nextExampleIndex.current = randomExampleIndex();
      return undefined;
    }
    const timer = window.setInterval(advance, REQUEST_EXAMPLE_DELAY_MS);
    return () => window.clearInterval(timer);
  }, [visible, advance]);

  const forceTickRef = useRef(forceTick);
  useEffect(() => {
    if (forceTick === forceTickRef.current) return;
    forceTickRef.current = forceTick;
    if (visible) advance();
  }, [forceTick, visible, advance]);

  return <p className={`listening-placeholder ${visible ? "is-visible" : "is-hidden"}`} aria-label={showExample ? example.join(" ") : "Eidos에게 원하는 도움을 말해보세요."}>
    <span className={`listening-placeholder-text ${showExample ? "is-hidden" : "is-visible"}`} aria-hidden={showExample}>Eidos에게<br />원하는 도움을 말해보세요.</span>
    <span className={`listening-placeholder-text ${showExample ? "is-visible" : "is-hidden"}`} aria-hidden={!showExample}>
      {example.map((line, i) => <Fragment key={i}>{i > 0 && <br />}{line}</Fragment>)}
    </span>
  </p>;
}

function PromptDock({ intensity, attention }: { intensity: number; attention: boolean }) {
  const dockIntensity = Math.min(1, Math.max(0, intensity));
  return <div className={`prompt-dock-wrap ${attention ? "prompt-dock-attention" : ""}`} style={{ "--dock-intensity": dockIntensity.toFixed(3) } as CSSProperties} role="status" aria-live="polite">
    <img className="prompt-dock-image prompt-dock-image-base" src="/assets/InputField_1.png" alt="Say 'Eidos'" draggable={false} />
    <img className={`prompt-dock-image prompt-dock-image-active ${attention ? "is-visible" : ""}`} src="/assets/InputField_2.png" alt="" aria-hidden="true" draggable={false} />
  </div>;
}

function SomaDisplayName({ value }: { value: string }) {
  const match = value.match(/^(.*?)(\d+)$/);
  if (!match) return <>{value}</>;
  return <>{match[1]}<span className="soma-number">{match[2]}</span></>;
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
    <span className="ambient-glow-core" />
  </div>;
}

function StateGallery({ selectedRobotId, onSelectRobot }: { selectedRobotId: number | null; onSelectRobot: (id: number) => void }) {
  const robotId = selectedRobotId ?? 1;
  // "photo" shows the card flipped to its back face at photo-capture stage —
  // the exact position/size .result-card-back-robot renders each robot's
  // video at during the real photo flow — so every one of the 18 robots can
  // be clicked through and checked without running the whole app flow.
  const [galleryView, setGalleryView] = useState<"info" | "photo">("info");
  // draftOffsets is what's actually previewed (live, per slider drag);
  // savedOffsets tracks what the server currently has, purely to detect
  // unsaved changes and to revert to on demand.
  const [savedOffsets, setSavedOffsets] = useState<RobotCardOffsets>(DEFAULT_ROBOT_CARD_OFFSETS);
  const [draftOffsets, setDraftOffsets] = useState<RobotCardOffsets>(DEFAULT_ROBOT_CARD_OFFSETS);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    fetch("/api/robot-card-offsets").then((response) => (response.ok ? response.json() as Promise<{ offsets?: RobotCardOffsets }> : null)).then((data) => {
      if (!data?.offsets || !Object.keys(data.offsets).length) return;
      setSavedOffsets((previous) => ({ ...previous, ...data.offsets }));
      setDraftOffsets((previous) => ({ ...previous, ...data.offsets }));
    }).catch(() => {});
  }, []);

  const draft = draftOffsets[robotId] ?? robotCardOffsetFor(DEFAULT_ROBOT_CARD_OFFSETS, robotId);
  const updateDraft = (patch: Partial<RobotCardOffset>) => {
    setSaveStatus("idle");
    setDraftOffsets((previous) => ({ ...previous, [robotId]: { ...(previous[robotId] ?? draft), ...patch } }));
  };
  const resetDraft = () => updateDraft(robotCardOffsetFor(DEFAULT_ROBOT_CARD_OFFSETS, robotId));
  const hasUnsavedChanges = JSON.stringify(draftOffsets) !== JSON.stringify(savedOffsets);

  const saveOffsets = async () => {
    setSaveStatus("saving");
    try {
      const response = await fetch("/api/robot-card-offsets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offsets: draftOffsets }),
      });
      if (!response.ok) throw new Error("save failed");
      const data = await response.json() as { offsets?: RobotCardOffsets };
      if (data.offsets) {
        setSavedOffsets(data.offsets);
        setDraftOffsets(data.offsets);
      }
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  };

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
    <div className="gallery-view-toggle" role="tablist" aria-label="Card view">
      <button type="button" role="tab" aria-selected={galleryView === "info"} className={galleryView === "info" ? "selected" : ""} onClick={() => setGalleryView("info")}>Info card (front)</button>
      <button type="button" role="tab" aria-selected={galleryView === "photo"} className={galleryView === "photo" ? "selected" : ""} onClick={() => setGalleryView("photo")}>Photo card · position &amp; size (back)</button>
    </div>
    {galleryView === "photo" && <div className="gallery-offset-panel">
      <div className="gallery-offset-row">
        <label>Scale <span>{draft.scale.toFixed(2)}</span>
          <input type="range" min="0.5" max="1.6" step="0.01" value={draft.scale} onChange={(event) => updateDraft({ scale: Number(event.target.value) })} />
        </label>
        <label>Top % <span>{draft.top.toFixed(1)}</span>
          <input type="range" min="-50" max="60" step="0.1" value={draft.top} onChange={(event) => updateDraft({ top: Number(event.target.value) })} />
        </label>
        <label>Left % <span>{draft.left.toFixed(1)}</span>
          <input type="range" min="-50" max="60" step="0.1" value={draft.left} onChange={(event) => updateDraft({ left: Number(event.target.value) })} />
        </label>
      </div>
      <div className="gallery-offset-actions">
        <button type="button" onClick={resetDraft}>Reset Robot {String(robotId).padStart(2, "0")} to default</button>
        <button type="button" onClick={() => void saveOffsets()} disabled={saveStatus === "saving" || !hasUnsavedChanges}>{saveStatus === "saving" ? "Saving…" : "Save — applies to the live app"}</button>
        {hasUnsavedChanges && saveStatus !== "saving" && <span className="gallery-offset-status">Unsaved changes</span>}
        {saveStatus === "saved" && !hasUnsavedChanges && <span className="gallery-offset-status status-good">Saved ✓</span>}
        {saveStatus === "error" && <span className="gallery-offset-status status-error">Save failed — is the server running?</span>}
      </div>
    </div>}
    <section className="gallery-result"><ResultScreen result={result} photoStage={galleryView === "photo" ? "photo-capture" : "card"} cameraStream={null} mock robotCardOffset={draft} /></section>
    <section className="gallery-grid">{ROBOT_IDS.map((id) => <button className={id === robotId ? "selected" : ""} type="button" key={id} onClick={() => onSelectRobot(id)}><img src={`/media/robot-${String(id).padStart(2, "0")}.webp`} alt={`Robot ${id}`} /><span>Robot {String(id).padStart(2, "0")}</span></button>)}</section>
  </main>;
}
