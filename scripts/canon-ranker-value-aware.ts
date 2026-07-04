/**
 * PROTOTYPE — value-aware census ranker (the ACTUAL gate for the canon-priming bound).
 *
 * Prior spike (scripts/canon-priming-bound.ts) found that ranking bare `type:name`
 * LABELS is intrinsically weak: jaccard is too sparse (`project:mneme` = 0.000 when the
 * text never says "mneme") and bge-cosine on 2-3 word labels is too flat (~0.8 floor).
 *
 * Fix: rank each candidate entity by the CLAIM VALUES filed under it (rich text →
 * discriminating), aggregated per entity. A subject is relevant to the batch text if
 * ANY claim under it is on-topic → aggregate with MAX. Same primitive as before
 * (SimilarityFn.scoreOne), just scored against values, not labels.
 *
 * Run: `npx tsx scripts/canon-ranker-value-aware.ts`           (jaccard, offline)
 *      `npx tsx scripts/canon-ranker-value-aware.ts --hybrid`  (embedding cosine over values)
 */
import { simJaccard, similarityFn, type SimilarityFn } from "../src/algebra/similarity.js";
import { initEmbeddings } from "../src/surface/embeddings.js";
import { warmValues } from "../src/algebra/embedding.js";

interface Claim { subject: string; key: string; value: string }

// ── a realistic multi-project claim set: a retrieval/architecture cluster + noise ──
const CLAIMS: Claim[] = [
  // relevant cluster — an extractor of a RETRIEVAL-topic chunk should reuse these
  { subject: "project:mneme", key: "architecture.retrieval", value: "Retrieval blends a similarity function with a recency term; a local embedding adapter powers cosine similarity and jaccard is the lexical fallback." },
  { subject: "project:mneme", key: "architecture.sync-vs-async", value: "remember() is synchronous; recall() is asynchronous and takes a deps argument carrying the embedding state." },
  { subject: "project:mneme", key: "design.canonical-priming-gap", value: "The canon prompt dumps the full census unranked; it needs relevance-bounded top-K priming against the batch text." },
  { subject: "component:recall-pipeline", key: "stages", value: "canonicalReadStages resolves the latest claim per subject-key, then ranks candidates by similarity and recency, then formats a token-bounded context." },
  { subject: "component:embedding-adapter", key: "model", value: "Local bge-base-en-v1.5 adapter, 768-dimensional, cosine similarity computed over cached value embeddings warmed before ranking." },
  // noise — different projects/domains; must sink
  { subject: "client:acme", key: "database.choice", value: "Acme chose Postgres for the primary store, migrating off MySQL last quarter." },
  { subject: "client:acme", key: "deadline", value: "Acme go-live deadline is 2026-08-01, hard gate on the launch." },
  { subject: "project:crewtracks", key: "feature.payroll", value: "Payroll exports run weekly and integrate with the time-tracking module for approvals." },
  { subject: "project:crewtracks", key: "feature.time-tracking", value: "Field crews log hours per job; supervisor approval gates the payroll run." },
  { subject: "person:kaleb", key: "role", value: "Kaleb owns the field-operations workflow and approves crew timesheets each week." },
  { subject: "host:web-01", key: "status", value: "web-01 runs the public API behind the load balancer and is currently healthy." },
  { subject: "vendor:fireflies", key: "integration", value: "Fireflies meeting transcripts are pulled by a small script and handed to the LLM extractor." },
  { subject: "project:agora", key: "architecture.dispatch", value: "Agora is the bypass-proof policy enforcement point governing sub-agent dispatch and execution." },
  { subject: "feature:payroll", key: "schedule", value: "Payroll is processed biweekly; direct deposit lands two business days after approval." },
  { subject: "deadline:q3", key: "milestone", value: "The Q3 milestone is general availability of the reporting MCP server." },
];

const BATCH_TEXT =
  "The recall pipeline ranks candidate claims by a similarity function blended with a " +
  "recency term; a local embedding adapter powers cosine similarity and jaccard is the " +
  "lexical fallback. This is the retrieval ranking path, distinct from the synchronous write path.";

// ── ranking: label vs value-aware ────────────────────────────────────────────
const uniq = <T,>(xs: T[]) => [...new Set(xs)];
function valuesBy(claims: Claim[], axis: "subject" | "key", entity: string): string[] {
  return claims.filter((c) => c[axis] === entity).map((c) => c.value);
}
/** value-aware score: a subject/key is as relevant as its BEST-matching claim value. */
function valueScore(text: string, values: string[], fn: SimilarityFn): number {
  return values.length ? Math.max(...values.map((v) => fn.scoreOne(v, text))) : 0;
}

interface Row { entity: string; label: number; value: number }
function rankAxis(claims: Claim[], axis: "subject" | "key", fn: SimilarityFn): Row[] {
  return uniq(claims.map((c) => c[axis]))
    .map((entity) => ({
      entity,
      label: fn.scoreOne(entity, BATCH_TEXT),
      value: valueScore(BATCH_TEXT, valuesBy(claims, axis, entity), fn),
    }))
    .sort((a, b) => b.value - a.value);
}

async function pickFn(): Promise<{ name: string; fn: SimilarityFn }> {
  if (!process.argv.includes("--hybrid")) return { name: "jaccard", fn: simJaccard };
  const state = await initEmbeddings();
  if (state.rankFn === "hybrid" && state.adapter && state.cache) {
    // warm the LABELS, the VALUES, and the query so cosineOver (cache-backed) can score all.
    const texts = uniq([...CLAIMS.map((c) => c.subject), ...CLAIMS.map((c) => c.key), ...CLAIMS.map((c) => c.value)]);
    await warmValues(state.adapter, state.cache, texts, [BATCH_TEXT]);
  }
  try { return { name: state.rankFn, fn: similarityFn(state.rankFn) }; }
  catch { return { name: "jaccard", fn: simJaccard }; }
}

// ── report ────────────────────────────────────────────────────────────────────
const { name, fn } = await pickFn();
const K = 5;
const mustKeepSubj = ["project:mneme", "component:recall-pipeline", "component:embedding-adapter"];
const mustDropSubj = ["client:acme", "person:kaleb", "deadline:q3"];

console.log(`ranker: ${name}\n`);

const subj = rankAxis(CLAIMS, "subject", fn);
console.log("=== subjects: label score  vs  value-aware score (sorted by value) ===");
console.log("  value  label  entity");
for (const r of subj) {
  const mark = mustKeepSubj.includes(r.entity) ? " ✓keep" : mustDropSubj.includes(r.entity) ? " ·noise" : "";
  console.log(`  ${r.value.toFixed(3)}  ${r.label.toFixed(3)}  ${r.entity}${mark}`);
}

const topByValue = subj.slice(0, K).map((r) => r.entity);
const topByLabel = [...subj].sort((a, b) => b.label - a.label).slice(0, K).map((r) => r.entity);
const keptV = mustKeepSubj.filter((e) => topByValue.includes(e)).length;
const keptL = mustKeepSubj.filter((e) => topByLabel.includes(e)).length;
const noiseV = mustDropSubj.filter((e) => topByValue.includes(e)).length;
const noiseL = mustDropSubj.filter((e) => topByLabel.includes(e)).length;

console.log(`\n=== top-${K} precision (of ${mustKeepSubj.length} must-keep, ${mustDropSubj.length} must-drop) ===`);
console.log(`  LABEL-ranked top-${K}:       kept ${keptL}/${mustKeepSubj.length} relevant, admitted ${noiseL} noise   [${topByLabel.join(", ")}]`);
console.log(`  VALUE-AWARE top-${K}:        kept ${keptV}/${mustKeepSubj.length} relevant, admitted ${noiseV} noise   [${topByValue.join(", ")}]`);

console.log(`\nVERDICT: ${keptV >= keptL && keptV === mustKeepSubj.length && noiseV <= noiseL
  ? "OK — value-aware ranking surfaces the on-topic subjects that label ranking missed"
  : "CHECK — value-aware did not clearly beat label ranking on this corpus"}`);

console.log(`\nnote: 'project:mneme' label score ${subj.find((r) => r.entity === "project:mneme")?.label.toFixed(3)} ` +
  `(the text never says "mneme") vs value-aware ${subj.find((r) => r.entity === "project:mneme")?.value.toFixed(3)} ` +
  `— scored via its claim values, not its bare label.`);
