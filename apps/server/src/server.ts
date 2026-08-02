import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AnalyzeRequest } from "@eidos/shared";
import { config, assertValidConfig } from "./config.js";
import { EidosDatabase } from "./db.js";
import { AnalysisService, mockAnalyze } from "./analysis.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../../..");
const webDist = path.join(projectRoot, "apps/web/dist");
const devMedia = path.join(projectRoot, "apps/web/public/media");
const dataDir = path.join(projectRoot, "data");
const database = new EidosDatabase(path.join(dataDir, "eidos.sqlite"));
const REALTIME_UPSTREAM_TIMEOUT_MS = 25_000;

let analysisService: AnalysisService | undefined;
if (!config.mockMode && config.openAiApiKey) {
  analysisService = new AnalysisService(config.routingModel, config.openAiApiKey);
}

function mediaDirectory(): string {
  const built = path.join(webDist, "media");
  return existsSync(built) ? built : devMedia;
}

function availableRobotIds(): number[] {
  const directory = mediaDirectory();
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map((name) => name.match(/^robot-(\d{2})\.webm$/)?.[1])
    .filter((id): id is string => Boolean(id))
    .filter((id) => existsSync(path.join(directory, `robot-${id}.webp`)))
    .map(Number)
    .sort((a, b) => a - b);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.post("/api/realtime/session", async (req, res) => {
  if (config.mockMode) return res.status(204).end();
  if (!config.openAiApiKey) return res.status(503).json({ error: "OpenAI API key is not configured." });

  const sessionConfig = {
    type: "transcription",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription: {
          model: config.transcriptionModel,
          languages: ["ko", "en"],
          keywords: ["Hi Eidos", "Eidos"],
          delay: "low",
        },
        turn_detection: null,
      },
    },
  };

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REALTIME_UPSTREAM_TIMEOUT_MS);
  const abortIfClientDisconnects = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on("aborted", abortIfClientDisconnects);
  res.on("close", abortIfClientDisconnects);

  try {
    const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session: sessionConfig }),
      signal: controller.signal,
    });
    const responseText = await upstream.text();
    const elapsedMs = Date.now() - started;
    const requestId = upstream.headers.get("x-request-id") ?? upstream.headers.get("x-openai-request-id") ?? "";
    const contentType = upstream.headers.get("content-type") ?? "";
    console.log(`[realtime] client secret upstream status=${upstream.status} elapsedMs=${elapsedMs}${requestId ? ` requestId=${requestId}` : ""} contentType=${contentType || "unknown"}`);

    if (!upstream.ok) {
      const bodyPreview = responseText.replace(/\s+/g, " ").trim().slice(0, 500);
      console.error(`[realtime] client secret upstream error status=${upstream.status}${requestId ? ` requestId=${requestId}` : ""}${bodyPreview ? ` body=${bodyPreview}` : ""}`);
      return res.status(502).json({
        error: "Realtime provider did not issue a client secret.",
        code: upstream.status === 504 ? "upstream_timeout" : "upstream_error",
        upstreamStatus: upstream.status,
        elapsedMs,
        requestId: requestId || undefined,
      });
    }

    let payload: { value?: string; expires_at?: number };
    try {
      payload = JSON.parse(responseText) as { value?: string; expires_at?: number };
    } catch {
      console.error("[realtime] client secret response was not JSON");
      return res.status(502).json({ error: "Realtime provider returned an invalid client secret response." });
    }
    if (!payload.value) {
      console.error("[realtime] client secret response did not include a value");
      return res.status(502).json({ error: "Realtime provider returned no client secret." });
    }

    return res.status(200).json({ clientSecret: payload.value, expiresAt: payload.expires_at });
  } catch (error) {
    const elapsedMs = Date.now() - started;
    if (controller.signal.aborted) {
      console.error(`[realtime] upstream request aborted or timed out after ${elapsedMs}ms`);
      return res.status(504).json({ error: "Realtime session request timed out.", elapsedMs });
    }
    console.error(`[realtime] session error after ${elapsedMs}ms`, error);
    return res.status(502).json({ error: "Failed to initialize realtime transcription." });
  } finally {
    clearTimeout(timeout);
    req.off("aborted", abortIfClientDisconnects);
    res.off("close", abortIfClientDisconnects);
  }
});

app.post("/api/analyze", async (req, res) => {
  const body = req.body as Partial<AnalyzeRequest>;
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : randomUUID();
  const startedAt = typeof body.startedAt === "string" ? body.startedAt : new Date().toISOString();
  const started = Date.now();
  if (!transcript) return res.status(400).json({ error: "Transcript is required." });

  try {
    const result = config.mockMode
      ? mockAnalyze(transcript, sessionId)
      : await analysisService!.analyze(transcript, sessionId);
    if (result.matchedRule === "fallback") {
      database.recordFailure({
        sessionId,
        transcript,
        startedAt,
        status: "error",
        latencyMs: Date.now() - started,
        error: "Visitor request could not be routed.",
      });
      return res.status(422).json({ code: "unroutable", error: "요청을 이해하지 못했습니다." });
    }
    const response = database.recordSuccess({
      sessionId,
      transcript,
      startedAt,
      status: "success",
      latencyMs: Date.now() - started,
      result,
    });
    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed.";
    database.recordFailure({ sessionId, transcript, startedAt, status: "error", latencyMs: Date.now() - started, error: message });
    console.error("Analysis error", error);
    res.status(502).json({ error: "분석에 실패했습니다. 잠시 후 다시 시도해 주세요." });
  }
});

app.get("/api/runtime", (_req, res) => {
  const ids = availableRobotIds();
  res.json({
    counter: database.getCounter(),
    assetsReady: ids.length === 18,
    availableRobotIds: ids,
    models: { routing: config.routingModel, transcription: config.transcriptionModel },
    mockMode: config.mockMode,
  });
});

app.get("/api/operator/status", (_req, res) => {
  const ids = availableRobotIds();
  res.json({
    ok: config.mockMode || Boolean(config.openAiApiKey),
    database: "ok",
    openAiConfigured: Boolean(config.openAiApiKey),
    assetsReady: ids.length === 18,
    assetCount: ids.length,
    latestError: database.latestError(),
  });
});

app.post("/api/operator/reset", (_req, res) => res.json({ ok: true, message: "Client reset requested." }));
app.post("/api/operator/counter/reset", (req, res) => {
  const body = req.body as { confirm?: boolean };
  if (body.confirm !== true) return res.status(400).json({ ok: false, error: "Counter reset confirmation is required." });
  database.resetCounter();
  res.json({ ok: true, counter: database.getCounter() });
});
app.get("/api/operator/sessions", (req, res) => res.json(database.listSessions(Number(req.query.limit ?? 50))));
app.use("/media", express.static(mediaDirectory(), { maxAge: "1h" }));

if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api/") && !req.path.startsWith("/media/")) {
      return res.sendFile(path.join(webDist, "index.html"));
    }
    next();
  });
}

assertValidConfig();
app.listen(config.port, config.host, () => {
  database.prune();
  console.log(`Eidos server listening at http://${config.host}:${config.port}`);
  console.log(`Mode: ${config.mockMode ? "mock" : "live"}; assets: ${availableRobotIds().length}/18`);
});
