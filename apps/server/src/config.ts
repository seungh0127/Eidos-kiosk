import "dotenv/config";

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  openAiApiKey: process.env.OPENAI_API_KEY ?? "",
  routingModel: process.env.OPENAI_ROUTING_MODEL ?? "gpt-5.6-luna",
  transcriptionModel: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-live-transcribe",
  mockMode: process.env.EIDOS_MOCK === "true",
};

export function assertValidConfig(): void {
  if (!config.mockMode && !config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required unless EIDOS_MOCK=true.");
  }
}
