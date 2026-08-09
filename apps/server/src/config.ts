import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Resolve the repo-root .env explicitly: npm workspaces run this script with
// cwd set to apps/server, so the default dotenv/config (cwd-relative) lookup
// silently misses the root .env and OPENAI_API_KEY appears unset.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../.env") });

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  openAiApiKey: process.env.OPENAI_API_KEY ?? "",
  routingModel: process.env.OPENAI_ROUTING_MODEL ?? "gpt-5.6-luna",
  transcriptionModel: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-live-transcribe",
  realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1-mini",
  mockMode: process.env.EIDOS_MOCK === "true",
};

export function assertValidConfig(): void {
  if (!config.mockMode && !config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required unless EIDOS_MOCK=true.");
  }
}
