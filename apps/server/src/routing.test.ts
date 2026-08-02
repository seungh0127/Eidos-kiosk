import { describe, expect, it } from "vitest";
import { chooseFallback, resolveHardRoute } from "./routing.js";

describe("Eidos deterministic routing", () => {
  it("prioritizes hidden code over environment rules", () => {
    const route = resolveHardRoute("나 물이 많은 곳을 점검하고 씻어낼 도움이 필요해. 눈길도 스캔해줘.");
    expect(route?.robotId).toBe(14);
    expect(route?.matchedRule).toBe("hidden-code");
  });

  it("prioritizes scan over water and snow", () => {
    expect(resolveHardRoute("눈이 쌓인 수영장을 스캔하고 3D 지도로 기록해줘")?.robotId).toBe(18);
  });

  it("routes water and snow environments", () => {
    expect(resolveHardRoute("수영장 물청소를 해줘")?.robotId).toBe(14);
    expect(resolveHardRoute("스키장에서 장비를 운반해줘")?.robotId).toBe(12);
  });

  it("uses a deterministic injectable fallback", () => {
    expect(chooseFallback(() => 0.1)).toBe(1);
    expect(chooseFallback(() => 0.9)).toBe(2);
  });
});
