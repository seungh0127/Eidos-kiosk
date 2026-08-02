import OpenAI from "openai";
import { z } from "zod";
import type { AnalysisResult, MatchedRule } from "@eidos/shared";
import { ROBOT_CATALOG, ROUTING_POLICY } from "./robotCatalog.js";
import { chooseFallback, resolveHardRoute, resolveMockSemanticRoute } from "./routing.js";

const modelAnalysisSchema = z.object({
  robotId: z.number().int().min(1).max(18),
  title: z.string().min(1),
  requiredTasks: z.array(z.string().min(1)).min(3).max(5),
  matchedRule: z.enum(["group-a", "group-b", "group-c", "group-d", "group-e", "group-f", "group-g", "semantic", "fallback"]),
  rationale: z.string().min(1).max(240),
});

const structuredSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    robotId: { type: "integer", enum: Array.from({ length: 18 }, (_, index) => index + 1) },
    title: { type: "string", description: "A concise English title with 2 to 5 words." },
    requiredTasks: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", description: "An English task label with 1 to 4 words." },
    },
    matchedRule: { type: "string", enum: ["group-a", "group-b", "group-c", "group-d", "group-e", "group-f", "group-g", "semantic", "fallback"] },
    rationale: { type: "string", maxLength: 240, description: "One short internal routing sentence, 240 characters maximum; not shown on the exhibition screen." },
  },
  required: ["robotId", "title", "requiredTasks", "matchedRule", "rationale"],
} as const;

const wordCount = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;

function normalizeModelOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const output = { ...(value as Record<string, unknown>) };
  if (typeof output.rationale === "string" && output.rationale.length > 240) {
    output.rationale = `${output.rationale.slice(0, 237).trimEnd()}...`;
  }
  return output;
}

function catalogText(): string {
  return ROBOT_CATALOG.map((robot) => [
    `ROBOT ${robot.id}: ${robot.name}`,
    `Summary: ${robot.summary}`,
    `Capabilities: ${robot.capabilities.join(", ")}`,
    `Limitations: ${robot.limitations.join(", ")}`,
  ].join("\n")).join("\n\n");
}

export class AnalysisService {
  private readonly client: OpenAI;

  constructor(private readonly model: string, apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async analyze(transcript: string, forcedSessionId?: string): Promise<AnalysisResult> {
    const hardRoute = resolveHardRoute(transcript);
    const fallbackRobotId = chooseFallback();
    const sessionId = forcedSessionId ?? crypto.randomUUID();
    const developerPrompt = `You route one visitor request to one Eidos robot and generate the exhibition output.

${ROUTING_POLICY}

Robot catalog:
${catalogText()}

Output requirements:
- Return JSON matching the supplied schema.
- The selected robot must be physically appropriate according to the catalog.
- Use English only for title, tasks, and rationale.
- Title must be 2-5 words. Return 3-5 task labels, each 1-4 words.
- Rationale must be one short English sentence of no more than 240 characters.
- Do not mention the algorithm, LLM, or uncertainty in the title or task labels.
- If a hard route is supplied below, preserve its robot ID and use matchedRule as fallback only if the supplied route is fallback.
- If no semantic group applies, use exactly the supplied fallback candidate.

Hard route: ${hardRoute ? JSON.stringify(hardRoute) : "none"}
Fallback candidate: robot ${fallbackRobotId}
`;

    const response = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: "medium" },
      input: [
        { role: "developer", content: [{ type: "input_text", text: developerPrompt }] },
        { role: "user", content: [{ type: "input_text", text: transcript }] },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "eidos_robot_analysis",
          strict: true,
          schema: structuredSchema,
        },
      },
    } as never);

    const parsed = modelAnalysisSchema.parse(normalizeModelOutput(JSON.parse(response.output_text)));
    if (hardRoute && parsed.robotId !== hardRoute.robotId) {
      throw new Error(`Model violated deterministic route: expected ${hardRoute.robotId}, received ${parsed.robotId}`);
    }
    if (wordCount(parsed.title) < 2 || wordCount(parsed.title) > 5) {
      throw new Error("Generated title is outside the 2-5 word limit.");
    }
    if (parsed.requiredTasks.some((task) => wordCount(task) < 1 || wordCount(task) > 4)) {
      throw new Error("Generated task label is outside the 1-4 word limit.");
    }

    return {
      sessionId,
      robotId: parsed.robotId,
      displayName: "",
      title: parsed.title,
      requiredTasks: parsed.requiredTasks,
      matchedRule: parsed.matchedRule as MatchedRule,
      videoUrl: `/media/robot-${String(parsed.robotId).padStart(2, "0")}.webm`,
    };
  }
}

export function mockAnalyze(transcript: string, sessionId: string = crypto.randomUUID()): AnalysisResult {
  const hardRoute = resolveHardRoute(transcript);
  const semanticRoute = hardRoute ? undefined : resolveMockSemanticRoute(transcript);
  const robotId = hardRoute?.robotId ?? semanticRoute?.robotId ?? chooseFallback(() => 0.25);
  const matchedRule: MatchedRule = hardRoute?.matchedRule ?? semanticRoute?.matchedRule ?? "fallback";

  const robot = ROBOT_CATALOG.find((entry) => entry.id === robotId)!;
  return {
    sessionId,
    robotId,
    displayName: "",
    title: `${robot.name.replace(/\b(Mr\.|LIL|MINI|THE)\b/g, "").trim().split(/\s+/).slice(0, 3).join(" ")} Support`,
    requiredTasks: robot.capabilities.slice(0, 4).map((task) => task.replace(/\b\w/g, (letter) => letter.toUpperCase())),
    matchedRule,
    videoUrl: `/media/robot-${String(robotId).padStart(2, "0")}.webm`,
  };
}
