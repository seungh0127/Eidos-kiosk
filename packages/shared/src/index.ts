export const ROBOT_IDS = Array.from({ length: 18 }, (_, index) => index + 1) as number[];

export type KioskPhase =
  | "boot"
  | "idle"
  | "presence"
  | "realtime-connecting"
  | "wake-listen"
  | "request-listen"
  | "analyzing"
  | "result"
  | "error"
  | "wait-for-exit";

export type MatchedRule =
  | "hidden-code"
  | "environment"
  | "group-a"
  | "group-b"
  | "group-c"
  | "group-d"
  | "group-e"
  | "group-f"
  | "group-g"
  | "semantic"
  | "fallback";

export type AnalysisResult = {
  sessionId: string;
  robotId: number;
  displayName: string;
  title: string;
  requiredTasks: string[];
  matchedRule: MatchedRule;
  videoUrl: string;
};

export type RuntimeStatus = {
  counter: number;
  assetsReady: boolean;
  availableRobotIds: number[];
  models: {
    routing: string;
    transcription: string;
    realtime: string;
  };
  mockMode: boolean;
  photoSharingConfigured: boolean;
};

export type OperatorStatus = {
  ok: boolean;
  database: "ok" | "error";
  openAiConfigured: boolean;
  photoSharingConfigured: boolean;
  assetsReady: boolean;
  assetCount: number;
  latestError?: string;
};

export type AnalyzeRequest = {
  sessionId?: string;
  transcript: string;
  startedAt?: string;
};

// Per-robot correction for the photo-capture card's .result-card-back-robot
// overlay (see apps/web/src/styles.css) — the 18 source videos each frame
// their robot at a different scale/position within their own frame, so a
// single shared box doesn't render every robot at the same apparent size.
// Tuned live from the ?gallery Photo-card view and persisted server-side so
// the change applies everywhere without a rebuild.
export type RobotCardOffset = { scale: number; top: number; left: number };
export type RobotCardOffsets = Record<number, RobotCardOffset>;
