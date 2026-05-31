/** Worker: opens the shared store and writes `count` claims to `corpus`. Reports {label, ok, err}. */
import { openSession } from "../../src/surface/index.js";

const [dbPath, corpus, countStr, label] = process.argv.slice(2);
const count = Number(countStr);
const s = openSession({ dbPath, writer: label });
let ok = 0;
let err = 0;
let firstErr = "";
for (let i = 0; i < count; i++) {
  try {
    const r = s.write(corpus, { subject: `${label}:s${i}`, key: "k", value: `v${i}` });
    if (r.status === "committed") ok++;
    else err++;
  } catch (e) {
    err++;
    if (!firstErr) firstErr = (e as Error).message;
  }
}
s.close();
console.log(JSON.stringify({ label, ok, err, firstErr }));
