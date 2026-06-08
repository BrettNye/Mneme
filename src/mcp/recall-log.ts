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
  /** Count of question entities with no claim available to this recall
   *  (coverage.missing.length). The first real-use distribution of the
   *  coverage signal — observation-only, does not alter served results.
   *  Optional so pre-enrichment log lines stay valid (additive schema). */
  missingCount?: number;
  /** The missing entity strings themselves (coverage.missing). */
  missing?: string[];
  /** Count of non-fatal warnings surfaced by the recall (warnings?.length ?? 0). */
  warningCount?: number;
  /** The subject filter arg the call used, when filtered. Omitted when unfiltered. */
  subject?: string;
  /** The key filter arg the call used, when filtered. Omitted when unfiltered. */
  key?: string;
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
