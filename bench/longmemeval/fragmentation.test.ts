/**
 * Sensitivity test for the fragmentation metric. Per the drift-injection lesson,
 * verify the instrument MOVES before trusting any number it produces: a corpus with
 * fragmented subjects must score higher than the same facts under one canonical
 * subject. If this fails, the whole canon-priming arm is measuring nothing.
 */
import { describe, it, expect } from "vitest";
import { openSession } from "../../src/surface/index.js";
import type { Session, WriteRecord, ReadDeps } from "../../src/surface/index.js";
import { fragmentation } from "./fragmentation.js";

const DEPS: ReadDeps = { embeddings: { rankFn: "jaccard" } }; // offline, deterministic

function corpusWith(subjects: [string, string, string][]): Session {
  const session = openSession({ dbPath: ":memory:", writer: "frag-test" });
  const id = "frag";
  session.createCorpus({ id });
  const records: WriteRecord[] = subjects.map(([subject, key, value]) => ({
    subject,
    key,
    value,
    valid: { from: 1_780_000_000_000, to: Infinity },
  }));
  session.writeMany(id, records);
  return session;
}

describe("fragmentation metric sensitivity", () => {
  it("detects near-duplicate subjects (the same entity fragmented across 3 subjects)", async () => {
    // acme fragmented into 3 near-dup subjects + 2 genuinely distinct subjects.
    const session = corpusWith([
      ["client:acme", "database.choice", "Postgres"],
      ["client:acme-corp", "deadline", "2026-08-01"],
      ["client:acme-inc", "owner", "Dana"],
      ["project:zephyr", "status", "in flight"],
      ["person:dana", "role", "field ops lead"],
    ]);
    const rep = await fragmentation(session, "frag", DEPS, { threshold: 0.6 });
    session.close();

    expect(rep.distinctSubjects).toBe(5);
    // the acme cluster must produce near-dup pairs (acme↔acme-corp, acme↔acme-inc are ~0.67 jaccard).
    expect(rep.nearDupPairs).toBeGreaterThanOrEqual(2);
    // the worst pair must be inside the acme cluster.
    const worst = rep.worst[0];
    expect(worst.a + worst.b).toMatch(/acme/);
  });

  it("scores lower when the same facts use ONE canonical subject", async () => {
    const fragmented = corpusWith([
      ["client:acme", "database.choice", "Postgres"],
      ["client:acme-corp", "deadline", "2026-08-01"],
      ["client:acme-inc", "owner", "Dana"],
    ]);
    const fragRep = await fragmentation(fragmented, "frag", DEPS, { threshold: 0.6 });
    fragmented.close();

    const canonical = corpusWith([
      ["client:acme", "database.choice", "Postgres"],
      ["client:acme", "deadline", "2026-08-01"],
      ["client:acme", "owner", "Dana"],
    ]);
    const canonRep = await fragmentation(canonical, "frag", DEPS, { threshold: 0.6 });
    canonical.close();

    // the metric must MOVE: canonicalized < fragmented, and ideally zero near-dup pairs.
    expect(canonRep.nearDupPairs).toBeLessThan(fragRep.nearDupPairs);
    expect(canonRep.nearDupPairs).toBe(0);
    expect(canonRep.distinctSubjects).toBe(1);
  });
});
