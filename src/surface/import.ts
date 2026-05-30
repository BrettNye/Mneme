import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { scalarConfidence } from "../core/confidence.js";
import type { Session, WriteRecord, ImportStats } from "./types.js";

export type RowMapper = (row: unknown) => WriteRecord | null; // null => skip row

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export const mappers: Record<"jsonl" | "conceptnet" | "icews", RowMapper> = {
  jsonl: (row) => row as WriteRecord,
  conceptnet: (row) => {
    const r = row as { start: string; rel: string; end: string; weight?: number };
    const p = clamp01(r.weight ?? 1);
    return {
      subject: r.start,
      key: r.rel,
      value: r.end,
      source: "imported",
      confidence: scalarConfidence(p),
    };
  },
  icews: (row) => {
    const r = row as { subject: string; relation: string; object: string; timestamp: number };
    return {
      subject: r.subject,
      key: r.relation,
      value: r.object,
      source: "imported",
      valid: { from: Number(r.timestamp), to: Infinity },
    };
  },
};

/** Stream a JSONL file into a corpus; returns accumulated stats. */
export async function importFile(
  session: Session,
  corpusId: string,
  filePath: string,
  opts: {
    format: "jsonl" | "conceptnet" | "icews";
    batchSize?: number;
    map?: RowMapper;
    onProgress?: (n: number) => void;
  },
): Promise<ImportStats> {
  const map = opts.map ?? mappers[opts.format];
  const batchSize = opts.batchSize ?? 1000;
  const started = Date.now();
  const acc: ImportStats = {
    total: 0,
    committed: 0,
    rejected: 0,
    duplicate: 0,
    skipped: 0,
    elapsedMs: 0,
    claimsPerSec: 0,
  };
  let buf: WriteRecord[] = [];

  const flush = (): void => {
    if (buf.length === 0) return;
    const s = session.writeMany(corpusId, buf);
    acc.committed += s.committed;
    acc.rejected += s.rejected;
    acc.duplicate += s.duplicate;
    buf = [];
  };

  const rl = createInterface({
    input: createReadStream(filePath, "utf8"),
    crlfDelay: Infinity,
  });
  rl.on("error", (err) => {
    throw new Error(`failed to read ${filePath}: ${(err as Error).message}`);
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    acc.total++;
    let rec: WriteRecord | null = null;
    try {
      rec = map(JSON.parse(line));
    } catch {
      acc.skipped++;
      continue;
    }
    if (!rec) {
      acc.skipped++;
      continue;
    }
    buf.push(rec);
    if (buf.length >= batchSize) {
      flush();
      opts.onProgress?.(acc.total);
    }
  }
  flush();

  acc.elapsedMs = Date.now() - started;
  acc.claimsPerSec =
    acc.elapsedMs > 0 ? Math.round((acc.committed / acc.elapsedMs) * 1000) : 0;
  return acc;
}
