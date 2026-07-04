/**
 * PROTOTYPE (final) — boundedCanon: the finished canon-priming bound.
 *
 * Closes the gate found across two prior spikes:
 *   - rank by claim VALUES (max-agg per entity), not bare `type:name` labels;
 *   - blend = JACCARD-LED + cosine as a MIN-MAX-NORMALIZED paraphrase backfill,
 *     NOT hybridMax(max) (whose ~0.76 cosine floor flattens the noise band).
 *
 * This test adds a genuine PARAPHRASE entity (`component:relevance-scorer`): its claim
 * value means "retrieval ranking by similarity + recency" but shares ~no tokens with the
 * query — so jaccard blinds to it and cosine must carry. The blend should be the ONLY
 * ranker that puts ALL must-keep (incl. the paraphrase) in top-K without admitting noise.
 *
 * Run: `npx tsx scripts/canon-bounded-final.ts`   (needs the embedding model; degrades to
 *       jaccard-only with a warning if it can't load — paraphrase won't be caught then).
 */
import { simJaccard, similarityFn, type SimilarityFn } from "../src/algebra/similarity.js";
import { initEmbeddings } from "../src/surface/embeddings.js";
import { warmValues } from "../src/algebra/embedding.js";

interface Claim { subject: string; key: string; value: string }
const BETA = 0.3; // cosine-backfill weight: < max jaccard so jaccard leads when present.

const CLAIMS: Claim[] = [
  // vocabulary-sharing relevant (high jaccard)
  { subject: "project:mneme", key: "architecture.retrieval", value: "Retrieval blends a similarity function with a recency term; a local embedding adapter powers cosine similarity and jaccard is the lexical fallback." },
  { subject: "component:recall-pipeline", key: "stages", value: "canonicalReadStages resolves the latest claim per subject-key, then ranks candidates by similarity and recency, then formats a token-bounded context." },
  { subject: "component:embedding-adapter", key: "model", value: "Local bge-base-en-v1.5 adapter, 768-dimensional, cosine similarity computed over cached value embeddings warmed before ranking." },
  // PARAPHRASE relevant — same concept, deliberately NO shared tokens with the query
  { subject: "component:relevance-scorer", key: "ordering", value: "Sorts stored memories by how close their meaning is to a request, preferring fresher entries whenever two are equally close." },
  // noise
  { subject: "client:acme", key: "database.choice", value: "Acme chose Postgres for the primary store, migrating off MySQL last quarter." },
  { subject: "client:acme", key: "deadline", value: "Acme go-live deadline is 2026-08-01, a hard gate on the launch." },
  { subject: "project:crewtracks", key: "feature.payroll", value: "Payroll exports run weekly and integrate with the time-tracking module for approvals." },
  { subject: "person:kaleb", key: "role", value: "Kaleb owns the field-operations workflow and approves crew timesheets each week." },
  { subject: "host:web-01", key: "status", value: "web-01 runs the public API behind the load balancer and is currently healthy." },
  { subject: "vendor:fireflies", key: "integration", value: "Fireflies meeting transcripts are pulled by a small script and handed to the LLM extractor." },
  { subject: "project:agora", key: "architecture.dispatch", value: "Agora is the bypass-proof policy enforcement point governing sub-agent dispatch and execution." },
  { subject: "deadline:q3", key: "milestone", value: "The Q3 milestone is general availability of the reporting MCP server." },
];

const QUERY =
  "The recall pipeline ranks candidate claims by a similarity function blended with a " +
  "recency term; a local embedding adapter powers cosine similarity and jaccard is the " +
  "lexical fallback. This is the retrieval ranking path, distinct from the synchronous write path.";

const MUST_KEEP = ["project:mneme", "component:recall-pipeline", "component:embedding-adapter", "component:relevance-scorer"];
const MUST_DROP = ["client:acme", "person:kaleb", "deadline:q3", "host:web-01"];
const K = 5;

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const subjectsOf = (cs: Claim[]) => uniq(cs.map((c) => c.subject));
const valuesOf = (cs: Claim[], s: string) => cs.filter((c) => c.subject === s).map((c) => c.value);
/** value-aware: an entity is as relevant as its best-matching claim value. */
const vScore = (text: string, values: string[], fn: SimilarityFn) =>
  values.length ? Math.max(...values.map((v) => fn.scoreOne(v, text))) : 0;

const minMax = (xs: number[]) => {
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return (x: number) => (hi > lo ? (x - lo) / (hi - lo) : 0);
};

interface Scored { entity: string; jac: number; cos: number; cosNorm: number; blend: number; hybridMax: number }

function scoreAll(cs: Claim[], query: string, jFn: SimilarityFn, cFn: SimilarityFn | null): Scored[] {
  const subs = subjectsOf(cs);
  const jac = subs.map((s) => vScore(query, valuesOf(cs, s), jFn));
  const cos = cFn ? subs.map((s) => vScore(query, valuesOf(cs, s), cFn)) : subs.map(() => 0);
  const norm = minMax(cos);
  return subs.map((entity, i) => {
    const cosNorm = norm(cos[i]);
    return {
      entity, jac: jac[i], cos: cos[i], cosNorm,
      blend: jac[i] + BETA * cosNorm,               // jaccard-led + normalized-cosine backfill
      hybridMax: Math.max(jac[i], cos[i]),           // the ranker recall uses, for contrast
    };
  });
}

const topK = (rows: Scored[], by: (r: Scored) => number) =>
  [...rows].sort((a, b) => by(b) - by(a)).slice(0, K).map((r) => r.entity);
const precision = (top: string[]) => ({
  kept: MUST_KEEP.filter((e) => top.includes(e)).length,
  noise: MUST_DROP.filter((e) => top.includes(e)).length,
});

// ── run ────────────────────────────────────────────────────────────────────────
const state = await initEmbeddings();
const hasEmb = state.rankFn === "hybrid" && !!state.adapter && !!state.cache;
if (hasEmb) {
  await warmValues(state.adapter!, state.cache!, uniq(CLAIMS.map((c) => c.value)), [QUERY]);
} else {
  console.log("⚠ embedding model unavailable — running jaccard-only; the paraphrase entity will NOT be caught.\n");
}
const cFn = hasEmb ? similarityFn("cosine") : null;
const rows = scoreAll(CLAIMS, QUERY, simJaccard, cFn);

console.log("=== per-subject scores (sorted by blend) ===");
console.log("  blend  jac   cosN  entity");
for (const r of [...rows].sort((a, b) => b.blend - a.blend)) {
  const tag = MUST_KEEP.includes(r.entity) ? (r.entity === "component:relevance-scorer" ? " ✓keep(paraphrase)" : " ✓keep")
    : MUST_DROP.includes(r.entity) ? " ·noise" : "";
  console.log(`  ${r.blend.toFixed(3)}  ${r.jac.toFixed(3)}  ${r.cosNorm.toFixed(3)}  ${r.entity}${tag}`);
}

const rankers: [string, (r: Scored) => number][] = [
  ["pure jaccard (value-aware)", (r) => r.jac],
  ["hybridMax    (value-aware)", (r) => r.hybridMax],
  ["BLEND jac+normCos          ", (r) => r.blend],
];
console.log(`\n=== top-${K} precision  (${MUST_KEEP.length} must-keep incl. 1 paraphrase, ${MUST_DROP.length} must-drop) ===`);
for (const [label, by] of rankers) {
  const top = topK(rows, by);
  const p = precision(top);
  const gotParaphrase = top.includes("component:relevance-scorer");
  console.log(`  ${label}: kept ${p.kept}/${MUST_KEEP.length} (paraphrase: ${gotParaphrase ? "✓" : "✗"}), noise ${p.noise}`);
}

const blendTop = topK(rows, (r) => r.blend);
const win = precision(blendTop).kept === MUST_KEEP.length && precision(blendTop).noise === 0;
console.log(`\nVERDICT: ${win
  ? "OK — the jaccard-led + normalized-cosine blend keeps ALL must-keep (incl. paraphrase) with zero noise"
  : "CHECK — blend did not cleanly capture the paraphrase without noise (tune BETA / K)"}`);

const rs = rows.find((r) => r.entity === "component:relevance-scorer")!;
console.log(`\nparaphrase entity 'component:relevance-scorer': jaccard ${rs.jac.toFixed(3)} (blind) · ` +
  `cosNorm ${rs.cosNorm.toFixed(3)} · blend ${rs.blend.toFixed(3)} — cosine backfill is what rescues it.`);
