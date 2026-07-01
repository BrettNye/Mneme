import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

it("no file under src/surface or src/retrieval imports from src/mcp", () => {
  const offenders: string[] = [];
  for (const dir of ["src/surface", "src/retrieval"]) {
    for (const f of tsFiles(dir)) {
      if (/from\s+["'][^"']*\/mcp\//.test(readFileSync(f, "utf8"))) offenders.push(f);
    }
  }
  expect(offenders, `these import from mcp: ${offenders.join(", ")}`).toEqual([]);
});
