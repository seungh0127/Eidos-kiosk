import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EidosDatabase } from "./db.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Eidos database", () => {
  it("persists the counter and does not double-count a session", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "eidos-db-test-"));
    tempDirs.push(directory);
    const database = new EidosDatabase(path.join(directory, "eidos.sqlite"));
    const result = {
      sessionId: "session-1",
      robotId: 1,
      displayName: "",
      title: "Indoor Delivery",
      requiredTasks: ["Receive Request", "Carry Items", "Deliver Items"],
      matchedRule: "semantic" as const,
      videoUrl: "/media/robot-01.webm",
    };

    expect(database.getCounter()).toBe(0);
    expect(database.recordSuccess({ sessionId: "session-1", transcript: "도와줘", status: "success", result })).toMatchObject({ displayName: "Soma 001" });
    expect(database.getCounter()).toBe(1);
    expect(database.recordSuccess({ sessionId: "session-1", transcript: "도와줘", status: "success", result })).toMatchObject({ displayName: "Soma 001" });
    expect(database.getCounter()).toBe(1);

    database.recordFailure({ sessionId: "session-1", transcript: "도와줘", status: "error", error: "late error" });
    expect(database.listSessions(10)[0]).toMatchObject({ status: "success" });

    database.resetCounter();
    expect(database.getCounter()).toBe(0);
    expect(database.listSessions(10)[0]).toMatchObject({ status: "success" });
  });
});
