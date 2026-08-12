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
  r2AccountId: process.env.R2_ACCOUNT_ID ?? "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  r2BucketName: process.env.R2_BUCKET_NAME ?? "",
  photoUrlTtlSeconds: (() => {
    const value = Number(process.env.PHOTO_URL_TTL_SECONDS ?? 3600);
    return Number.isFinite(value) ? Math.min(86_400, Math.max(300, value)) : 3600;
  })(),
};

export const photoSharingConfigured = Boolean(
  config.r2AccountId && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2BucketName,
);

export function assertValidConfig(): void {
  if (!config.mockMode && !config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required unless EIDOS_MOCK=true.");
  }
}
