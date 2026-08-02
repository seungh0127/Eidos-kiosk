import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AnalysisResult } from "@eidos/shared";

export type SessionRecord = {
  sessionId: string;
  transcript: string;
  result?: AnalysisResult;
  startedAt?: string;
  status: "success" | "error";
  latencyMs?: number;
  error?: string;
};

export class EidosDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO app_state (key, value) VALUES ('counter', '0');
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at TEXT,
        transcript TEXT NOT NULL,
        status TEXT NOT NULL,
        robot_id INTEGER,
        display_name TEXT,
        title TEXT,
        required_tasks TEXT,
        matched_rule TEXT,
        video_url TEXT,
        latency_ms INTEGER,
        error TEXT
      );
      DELETE FROM sessions WHERE created_at < datetime('now', '-30 days');
    `);
  }

  getCounter(): number {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = 'counter'").get() as { value?: string } | undefined;
    return Number(row?.value ?? 0);
  }

  resetCounter(): void {
    this.db.prepare("UPDATE app_state SET value = '0' WHERE key = 'counter'").run();
  }

  recordSuccess(record: SessionRecord & { result: AnalysisResult }): AnalysisResult {
    const existing = this.db.prepare(`
      SELECT id, robot_id, display_name, title, required_tasks, matched_rule, video_url
      FROM sessions WHERE id = ? AND status = 'success'
    `).get(record.sessionId) as {
      id: string;
      robot_id: number;
      display_name: string;
      title: string;
      required_tasks: string;
      matched_rule: AnalysisResult["matchedRule"];
      video_url: string;
    } | undefined;
    if (existing) {
      return {
        sessionId: existing.id,
        robotId: existing.robot_id,
        displayName: existing.display_name,
        title: existing.title,
        requiredTasks: JSON.parse(existing.required_tasks) as string[],
        matchedRule: existing.matched_rule,
        videoUrl: existing.video_url,
      };
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const counter = this.getCounter() + 1;
      const displayName = `Soma ${String(counter).padStart(3, "0")}`;
      const result = { ...record.result, displayName };
      this.db.prepare("UPDATE app_state SET value = ? WHERE key = 'counter'").run(String(counter));
      this.db.prepare(`
        INSERT OR REPLACE INTO sessions
          (id, started_at, transcript, status, robot_id, display_name, title, required_tasks, matched_rule, video_url, latency_ms)
        VALUES (?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.sessionId,
        record.startedAt ?? null,
        record.transcript,
        result.robotId,
        result.displayName,
        result.title,
        JSON.stringify(result.requiredTasks),
        result.matchedRule,
        result.videoUrl,
        record.latencyMs ?? null,
      );
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordFailure(record: SessionRecord): void {
    const existing = this.db.prepare("SELECT status FROM sessions WHERE id = ?").get(record.sessionId) as { status?: string } | undefined;
    if (existing?.status === "success") return;
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, started_at, transcript, status, latency_ms, error)
      VALUES (?, ?, ?, 'error', ?, ?)
    `).run(record.sessionId, record.startedAt ?? null, record.transcript, record.latencyMs ?? null, record.error ?? "Unknown error");
  }

  listSessions(limit = 50): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`
      SELECT id, created_at, started_at, transcript, status, robot_id, display_name, title,
             required_tasks, matched_rule, video_url, latency_ms, error
      FROM sessions ORDER BY created_at DESC LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 200));
    return rows as Array<Record<string, unknown>>;
  }

  latestError(): string | undefined {
    const row = this.db.prepare("SELECT error FROM sessions WHERE status = 'error' AND error IS NOT NULL ORDER BY created_at DESC LIMIT 1").get() as { error?: string } | undefined;
    return row?.error;
  }

  prune(): void {
    this.db.prepare("DELETE FROM sessions WHERE created_at < datetime('now', '-30 days')").run();
  }
}
