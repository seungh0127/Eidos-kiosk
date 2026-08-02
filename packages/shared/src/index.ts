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
  };
  mockMode: boolean;
};

export type OperatorStatus = {
  ok: boolean;
  database: "ok" | "error";
  openAiConfigured: boolean;
  assetsReady: boolean;
  assetCount: number;
  latestError?: string;
};

export type AnalyzeRequest = {
  sessionId?: string;
  transcript: string;
  startedAt?: string;
};
