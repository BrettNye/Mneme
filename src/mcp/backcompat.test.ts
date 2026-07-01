import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall, remember } from "./index.js";           // the mneme/mcp barrel
import { recall as rootRecall, remember as rootRemember } from "../index.js"; // the root mneme barrel
import { openSession } from "../surface/index.js";
import { jaccardDeps } from "../surface/test-support.js";

it("recall/remember re-exported from the mcp barrel still round-trip", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "mneme-bc-")), "store.db");
  const session = openSession({ dbPath, writer: "test" });
  remember(session, { subject: "project:x", key: "status", value: "green", corpus: "c" });
  const r = await recall(session, { about: "project:x status", corpus: "c" }, jaccardDeps);
  expect(r.content).toContain("green");
  session.close();
});

it("recall/remember re-exported from the ROOT mneme barrel still round-trip", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "mneme-bc-root-")), "store.db");
  const session = openSession({ dbPath, writer: "test" });
  rootRemember(session, { subject: "project:x", key: "status", value: "green", corpus: "c" });
  const r = await rootRecall(session, { about: "project:x status", corpus: "c" }, jaccardDeps);
  expect(r.content).toContain("green");
  session.close();
});
