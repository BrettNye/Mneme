/** Tiny measurement helpers for the benchmark harness. */

/** Sample resident-set-size repeatedly and retain the peak. */
export function peakRss(): { sample: () => void; peakBytes: () => number } {
  let peak = process.memoryUsage().rss;
  return {
    sample(): void {
      const r = process.memoryUsage().rss;
      if (r > peak) peak = r;
    },
    peakBytes: () => peak,
  };
}

export const toMB = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;

/** Time a synchronous function, returning its result and elapsed milliseconds. */
export function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = Date.now();
  const result = fn();
  return { result, ms: Date.now() - start };
}

/** Render an array of flat row objects as a GitHub-flavored markdown table. */
export function markdownTable(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return "(no rows)";
  const cols = Object.keys(rows[0]);
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`).join("\n");
  return [header, sep, body].join("\n");
}
