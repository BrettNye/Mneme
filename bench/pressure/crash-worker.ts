/** Crash worker: writes claims to `corpus` forever (until SIGKILL'd), printing running count to stderr. */
import { openSession } from "../../src/surface/index.js";

const [dbPath, corpus, label] = process.argv.slice(2);
const s = openSession({ dbPath, writer: label });
let n = 0;
// Tight loop, no upper bound — the parent kills us mid-stream to simulate a crash.
for (;;) {
  s.write(corpus, { subject: `${label}:s${n}`, key: "k", value: `v${n}` });
  n++;
  if (n % 50 === 0) process.stderr.write(`${n}\n`);
}
