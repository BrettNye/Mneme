import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RecallLogEntry {
  ts: string;
  corpus: string;
  about: string;
  topScore?: number;
  matchCount: number;
  abstained: boolean;
  rankFn: string;
}

/**
 * Appends one JSON line to <dirname(dbPath)>/recall-log.jsonl.
 * Best-effort: any failure goes to console.error and is swallowed —
 * NEVER throws into the tool path.
 */
export function appendRecallLog(dbPath: string, entry: RecallLogEntry): void {
  try {
    const logPath = join(dirname(dbPath), "recall-log.jsonl");
    appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error("[recall-log] Failed to append entry:", err);
  }
}
