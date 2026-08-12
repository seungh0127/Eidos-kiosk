import "dotenv/config";
import express from "express";
import path from "node:path";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AnalyzeRequest, RobotCardOffsets } from "@eidos/shared";
import { config, assertValidConfig, photoSharingConfigured } from "./config.js";
import { EidosDatabase } from "./db.js";
import { AnalysisService, mockAnalyze } from "./analysis.js";
import { resolveVisitorPhotoShare, uploadVisitorPhoto } from "./photo-storage.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../../..");
const webDist = path.join(projectRoot, "apps/web/dist");
const devMedia = path.join(projectRoot, "apps/web/public/media");
const dataDir = path.join(projectRoot, "data");
const database = new EidosDatabase(path.join(dataDir, "eidos.sqlite"));
const REALTIME_UPSTREAM_TIMEOUT_MS = 25_000;
const robotCardOffsetsPath = path.join(dataDir, "robot-card-offsets.json");

function firstLanIpv4Address(): string | undefined {
  const interfaces = networkInterfaces();
  const names = Object.keys(interfaces).sort((a, b) => {
    const rank = (name: string) => name === "en0" ? 0 : /^en\d+$/.test(name) ? 1 : /^(eth|wlan)\d+$/.test(name) ? 2 : 3;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  for (const name of names) {
    if (/^(lo|utun|bridge|awdl|llw)/.test(name)) continue;
    const addresses = interfaces[name];
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254.")) return address.address;
    }
  }
  return undefined;
}

function photoShareBaseUrl(req: express.Request): string {
  if (config.photoShareBaseUrl) return config.photoShareBaseUrl;

  const requestHost = req.get("host") ?? `127.0.0.1:${config.port}`;
  const requestHostname = requestHost.replace(/^\[/, "").replace(/\].*$/, "").split(":")[0]?.toLowerCase();
  if (requestHostname && requestHostname !== "127.0.0.1" && requestHostname !== "localhost") {
    return `${req.protocol}://${requestHost}`;
  }

  // The kiosk itself normally opens 127.0.0.1. A phone cannot resolve that
  // address, so use the Mac's LAN address for the compact QR redirect.
  const lanAddress = firstLanIpv4Address();
  return lanAddress ? `http://${lanAddress}:${config.port}` : `${req.protocol}://${requestHost}`;
}

function readRobotCardOffsets(): RobotCardOffsets {
  try {
    if (!existsSync(robotCardOffsetsPath)) return {};
    return JSON.parse(readFileSync(robotCardOffsetsPath, "utf-8")) as RobotCardOffsets;
  } catch {
    return {};
  }
}

// Clamped to a sane range so a malformed request can't push the overlay
// wildly off the card in production.
function sanitizeRobotCardOffsets(input: unknown): RobotCardOffsets {
  const clean: RobotCardOffsets = {};
  if (!input || typeof input !== "object") return clean;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 1 || id > 18) continue;
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const scale = Number(v.scale);
    const top = Number(v.top);
    const left = Number(v.left);
    if (![scale, top, left].every(Number.isFinite)) continue;
    clean[id] = {
      scale: Math.min(2, Math.max(0.3, scale)),
      top: Math.min(100, Math.max(-50, top)),
      left: Math.min(150, Math.max(-50, left)),
    };
  }
  return clean;
}

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

app.post("/api/photo", express.raw({ type: "image/jpeg", limit: "2mb" }), async (req, res) => {
  if (!photoSharingConfigured) return res.status(503).json({ error: "Photo sharing is not configured on this kiosk." });
  const image = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (image.length < 10_000) return res.status(400).json({ error: "The captured photo is empty or too small." });
  try {
    const uploaded = await uploadVisitorPhoto(image);
    const qrUrl = new URL(uploaded.sharePath, `${photoShareBaseUrl(req)}/`).toString();
    res.status(201).json({ shareUrl: uploaded.shareUrl, qrUrl, downloadUrl: uploaded.downloadUrl, expiresAt: uploaded.expiresAt, size: image.length, objectKey: uploaded.objectKey });
  } catch (error) {
    console.error("[photo] upload failed", error);
    res.status(502).json({ error: "The photo could not be uploaded." });
  }
});

app.get("/p/:date/:expires/:shareId/:signature", async (req, res) => {
  try {
    const target = await resolveVisitorPhotoShare(
      String(req.params.date),
      String(req.params.expires),
      String(req.params.shareId),
      String(req.params.signature),
    );
    res.setHeader("Cache-Control", "no-store");
    if (!target) return res.status(410).send("This Eidos photo link has expired.");
    return res.redirect(302, target);
  } catch (error) {
    console.error("[photo] short share link failed", error);
    return res.status(502).send("The Eidos photo is temporarily unavailable.");
  }
});

app.post("/api/realtime/session", async (req, res) => {
  if (config.mockMode) return res.status(204).end();
  if (!config.openAiApiKey) return res.status(503).json({ error: "OpenAI API key is not configured." });

  const sessionConfig = {
    // Semantic VAD is supported by the general Realtime session. The
    // transcription-only session accepts gpt-live-transcribe but rejects
    // semantic_vad, which was the source of the previous 400 errors.
    type: "realtime",
    model: config.realtimeModel,
    output_modalities: ["text"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription: {
          model: config.transcriptionModel,
          languages: ["ko", "en"],
          prompt: "Korean and English exhibition kiosk. The wake phrase is Hi Eidos, 하이 에이도스, 아이도스, or 에이도스.",
        },
        // Semantic VAD is active from the beginning. The browser uses the
        // streamed transcript deltas for wakeword detection, then waits for
        // the semantic boundary and completed transcript before routing.
        turn_detection: {
          type: "semantic_vad",
          eagerness: "medium",
          create_response: false,
          interrupt_response: false,
        },
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

    let providerMessage = "";
    try {
      const providerPayload = JSON.parse(responseText) as { error?: string | { message?: string } };
      providerMessage = typeof providerPayload.error === "string" ? providerPayload.error : providerPayload.error?.message ?? "";
    } catch {
      // The regular error path below handles non-JSON provider responses.
    }

    if (!upstream.ok) {
      const bodyPreview = responseText.replace(/\s+/g, " ").trim().slice(0, 500);
      console.error(`[realtime] client secret upstream error status=${upstream.status}${requestId ? ` requestId=${requestId}` : ""}${bodyPreview ? ` body=${bodyPreview}` : ""}`);
      const errorMessage = providerMessage
        ? `Realtime provider rejected session: ${providerMessage}`
        : "Realtime provider did not issue a client secret.";
      return res.status(502).json({
        error: errorMessage,
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

    return res.status(200).json({
      clientSecret: payload.value,
      expiresAt: payload.expires_at,
      turnDetection: "semantic_vad",
      realtimeModel: config.realtimeModel,
    });
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

app.get("/api/robot-card-offsets", (_req, res) => {
  res.json({ offsets: readRobotCardOffsets() });
});

app.post("/api/robot-card-offsets", (req, res) => {
  const body = req.body as { offsets?: unknown };
  const clean = sanitizeRobotCardOffsets(body.offsets);
  if (Object.keys(clean).length === 0) return res.status(400).json({ ok: false, error: "No valid robot offsets in request." });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(robotCardOffsetsPath, JSON.stringify(clean, null, 2), "utf-8");
  res.json({ ok: true, offsets: clean });
});

app.get("/api/runtime", (_req, res) => {
  const ids = availableRobotIds();
  res.json({
    counter: database.getCounter(),
    assetsReady: ids.length === 18,
    availableRobotIds: ids,
    models: { routing: config.routingModel, transcription: config.transcriptionModel, realtime: config.realtimeModel },
    mockMode: config.mockMode,
    photoSharingConfigured,
  });
});

app.get("/api/operator/status", (_req, res) => {
  const ids = availableRobotIds();
  res.json({
    ok: config.mockMode || Boolean(config.openAiApiKey),
    database: "ok",
    openAiConfigured: Boolean(config.openAiApiKey),
    photoSharingConfigured,
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

// Register the web routes even when the dist directory is not present yet.
// This keeps a long-running dev server from permanently becoming API-only
// after a later build creates apps/web/dist.
app.use(express.static(webDist));
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/") && !req.path.startsWith("/media/")) {
    return res.sendFile(path.join(webDist, "index.html"));
  }
  next();
});

assertValidConfig();
app.listen(config.port, config.host, () => {
  database.prune();
  console.log(`Eidos server listening at http://${config.host}:${config.port}`);
  console.log(`Mode: ${config.mockMode ? "mock" : "live"}; assets: ${availableRobotIds().length}/18`);
});
