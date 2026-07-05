/**
 * PROTOTYPE — canon-priming bound (the GATING task for the ctx→Mneme sweep).
 *
 * The gap (verified in src/surface/ingest.ts:177-185 + buildCanonPrompt:92-111):
 * ingest() primes the extractor with the FULL census — every subject and every key,
 * unranked. On a real multi-project corpus that is (a) unbounded token burn and
 * (b) mis-priming: dumping 100 irrelevant entities doesn't help the extractor reuse
 * the right one, it drowns it.
 *
 * The bound (composition-first — reuses Mneme's own SimilarityFn.scoreOne, the same
 * primitive rho ranks with; no new ranker invented): rank the census by relevance to
 * the batch text being extracted, keep top-K. This bounds the prompt AND sharpens
 * priming — the extractor sees only the entities a fact in THIS text could plausibly
 * concern.
 *
 * Run: `npx tsx scripts/canon-priming-bound.ts`  (jaccard, offline)
 *      `npx tsx scripts/canon-priming-bound.ts --hybrid`  (also tries embedding cosine)
 */
import { simJaccard, type SimilarityFn } from "../src/algebra/similarity.js";
import { initEmbeddings } from "../src/surface/embeddings.js";
import { similarityFn } from "../src/algebra/similarity.js";
import { warmValues } from "../src/algebra/embedding.js";

// ── the bound ─────────────────────────────────────────────────────────────────
interface Ranked { entity: string; score: number }
function rankByRelevance(text: string, entities: string[], fn: SimilarityFn): Ranked[] {
  return entities
    .map((entity) => ({ entity, score: fn.scoreOne(entity, text) }))
    .sort((a, b) => b.score - a.score);
}

interface BoundResult {
  subjects: string[];
  keys: string[];
  prompt: string;
  stats: { subjBefore: number; subjAfter: number; keyBefore: number; keyAfter: number; charsBefore: number; charsAfter: number };
}
function boundedCanon(
  text: string,
  subjects: string[],
  keys: string[],
  opts: { kSubjects: number; kKeys: number; fn: SimilarityFn },
): BoundResult {
  const rs = rankByRelevance(text, subjects, opts.fn).slice(0, opts.kSubjects).map((r) => r.entity);
  const rk = rankByRelevance(text, keys, opts.fn).slice(0, opts.kKeys).map((r) => r.entity);
  const prompt = buildCanonPrompt(rs, rk);
  return {
    subjects: rs,
    keys: rk,
    prompt,
    stats: {
      subjBefore: subjects.length, subjAfter: rs.length,
      keyBefore: keys.length, keyAfter: rk.length,
      charsBefore: buildCanonPrompt(subjects, keys).length,
      charsAfter: prompt.length,
    },
  };
}

// mirror of ingest.ts buildCanonPrompt (the anti-over-anchoring framing), operating on the bounded sets.
function buildCanonPrompt(subjects: string[], keys: string[]): string {
  const lines = [
    "## Canonical entities already in memory (relevance-bounded)",
    "Reuse an existing subject/key VERBATIM only for the SAME entity; MINT for anything genuinely new.",
    `**Subjects (${subjects.length}):**`,
    ...subjects.map((s) => `- ${s}`),
    `**Keys (${keys.length}):**`,
    ...keys.map((k) => `- ${k}`),
  ];
  return lines.join("\n");
}

// ── a realistic multi-project census (relevant to the batch text + lots of noise) ─
const SUBJECTS = [
  "project:mneme", "competitor:mem0", "competitor:ctx", "project:ai-os", "project:rastate",
  "resolver:resolve-deprecate-older", "component:recall-pipeline", "component:embedding-adapter",
  // noise from other projects/domains:
  "project:crewtracks", "client:liner-division", "client:acme", "person:kaleb", "person:brett",
  "project:agora", "project:pangolin", "project:stoa", "host:web-01", "host:db-02",
  "feature:time-tracking", "feature:payroll", "vendor:fireflies", "meeting:kickoff",
  "project:openclaw", "team:platform", "deadline:q3", "invoice:2026-06",
];
const KEYS = [
  "architecture.retrieval", "architecture.sync-vs-async", "design.canonical-priming-gap",
  "decision.jaccard-deps", "positioning.differentiator", "positioning.weakness",
  // noise:
  "deadline", "owner", "action-item", "workflow", "pricing", "status", "concern",
  "database.choice", "deployment.region", "auth.method", "billing.plan", "sla.uptime",
  "onboarding.steps", "release.date", "headcount", "budget", "vacation.policy",
];

// A batch chunk an extractor would process — deliberately does NOT contain the literal
// token "mneme", so a purely-lexical bound must rely on the KEY tokens, while a hybrid
// (embedding) bound can also surface the right SUBJECT semantically.
const BATCH_TEXT =
  "The recall pipeline ranks candidate claims by a similarity function blended with a " +
  "recency term; a local embedding adapter powers cosine similarity and jaccard is the " +
  "lexical fallback. This is the retrieval ranking path, distinct from the synchronous write path.";

async function pickFn(warmTexts: string[]): Promise<{ name: string; fn: SimilarityFn }> {
  if (!process.argv.includes("--hybrid")) return { name: "jaccard", fn: simJaccard };
  const state = await initEmbeddings();
  if (state.rankFn === "hybrid" && state.adapter && state.cache) {
    // cosineOver reads embeddings from a cache — warm the census + query first (as recall does).
    await warmValues(state.adapter, state.cache, warmTexts, [BATCH_TEXT]);
  }
  try {
    return { name: state.rankFn, fn: similarityFn(state.rankFn) };
  } catch {
    return { name: "jaccard", fn: simJaccard };
  }
}

const K_SUBJECTS = 5;
const K_KEYS = 6;
const { name, fn } = await pickFn([...SUBJECTS, ...KEYS]);

console.log(`ranker: ${name}   census: ${SUBJECTS.length} subjects, ${KEYS.length} keys\n`);

console.log(`=== top-${K_SUBJECTS} subjects by relevance to the batch text ===`);
for (const r of rankByRelevance(BATCH_TEXT, SUBJECTS, fn).slice(0, K_SUBJECTS)) {
  console.log(`  ${r.score.toFixed(3)}  ${r.entity}`);
}
console.log(`\n=== top-${K_KEYS} keys by relevance to the batch text ===`);
for (const r of rankByRelevance(BATCH_TEXT, KEYS, fn).slice(0, K_KEYS)) {
  console.log(`  ${r.score.toFixed(3)}  ${r.entity}`);
}

const bound = boundedCanon(BATCH_TEXT, SUBJECTS, KEYS, { kSubjects: K_SUBJECTS, kKeys: K_KEYS, fn });
const s = bound.stats;
const reduction = (1 - s.charsAfter / s.charsBefore) * 100;
console.log(`\n=== bound stats ===`);
console.log(`  subjects: ${s.subjBefore} -> ${s.subjAfter}   keys: ${s.keyBefore} -> ${s.keyAfter}`);
console.log(`  canon prompt chars: ${s.charsBefore} -> ${s.charsAfter}  (${reduction.toFixed(1)}% smaller)`);

// precision check: the entities an extractor of THIS text SHOULD reuse must survive the bound.
const mustKeepKeys = ["architecture.retrieval"];
const mustDropKeys = ["deadline", "vacation.policy", "billing.plan"];
const keptRight = mustKeepKeys.every((k) => bound.keys.includes(k));
const droppedNoise = mustDropKeys.every((k) => !bound.keys.includes(k));
console.log(`\n=== precision ===`);
console.log(`  kept the on-topic key(s) ${JSON.stringify(mustKeepKeys)}: ${keptRight}`);
console.log(`  dropped noise key(s) ${JSON.stringify(mustDropKeys)}: ${droppedNoise}`);
console.log(`\nVERDICT: ${keptRight && droppedNoise ? "OK — bound keeps the relevant canon, drops the noise" : "CHECK — bound missed a relevant entity or kept noise"}`);

console.log(`\n--- integration seam ---`);
console.log("ingest() builds canon BEFORE calling extract(), with no text. To wire this in, ingest");
console.log("needs the batch text at canon-build time: add an optional `canonQuery`/`sourceText` to");
console.log("IngestArgs and, when present, run boundedCanon() before buildCanonPrompt. Consumers that");
console.log("already have the text in their extract() callback can call boundedCanon(ctx.*, text) directly.");
