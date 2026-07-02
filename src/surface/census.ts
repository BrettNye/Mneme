/**
 * census.ts — keyCensus + the shared enumerate+score core.
 *
 * `censusCore` is the axis-generic enumerate+score primitive (built on
 * `distinctEntities` + `entityScorer` from entities.ts). `keyCensus` delegates
 * its enumerate+score work to `censusCore("key", …)` and layers its own
 * key-specific alias report (aliases / unratified / ratification content) on
 * top — behavior and signature unchanged from the pre-move implementation
 * that lived in recall.ts.
 */
import { distinctEntities, entityScorer, type EntityAxis } from "./entities.js";
import { loadAliasContext, MCP_EVIDENCE_POOLING_RULE, type EmbeddingState } from "./recall.js"; // hoisted fn; runtime-only call → cycle-safe
import { resolveKeyCardinality, cardinalityCollisions, formatCardinalityCollision, type CardinalityCollision } from "./cardinality.js";
import { pipe, leaf } from "../mneme.js";
import { canonicalReadStages } from "../retrieval/read-pipeline.js";
import type { Corpus } from "../algebra/types.js";
import type { Session, ReadDeps } from "./types.js";

export interface CensusArgs {
  corpus?: string;
  limit?: number;
  // corpus defaults at server layer
}

export interface CensusResult {
  corpus: string;
  keys: { key: string; claims: number }[];
  candidates: { a: string; b: string; score: number }[]; // sorted desc, truncated to limit
  aliases: Record<string, string>;
  unratified: string[];
  warnings: string[];
  rankFn: string;
  content: string; // composed text incl. remember-shape ratification affordance
  cardinalityCollisions: CardinalityCollision[]; // structural single-cardinality collisions (see cardinality.ts)
}

/**
 * Enumerate + score the axis; returns the shared census core + the single alias load.
 * Loads alias context exactly ONCE (shared `now`), enumerates live distinct entities
 * on `axis`, then scores all O(n²) pairs, sorted desc, truncated to `limit`.
 */
export async function censusCore(
  axis: EntityAxis,
  session: Session,
  corpus: string,
  deps: ReadDeps,
  limit: number,
) {
  const now = Date.now(); // ONE instant, shared by alias load + enumeration (matches keyCensus)
  const effective = resolveKeyCardinality(session, corpus, deps.keyCardinality);
  const aliasContext = loadAliasContext(session, corpus, now, effective);
  const entities = distinctEntities(session, corpus, axis, { ...deps, keyCardinality: effective }, aliasContext.aliasMap, now);
  const { rankFn, warnings, scoreOne } = await entityScorer(entities.map((e) => e.value), deps);

  const pairs: { a: string; b: string; score: number }[] = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      pairs.push({ a: entities[i].value, b: entities[j].value, score: scoreOne(entities[i].value, entities[j].value) });
    }
  }
  // Sort descending by score; tiebreaker by entity names for full determinism.
  pairs.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  return {
    entities,
    candidates: pairs.slice(0, limit),
    rankFn,
    warnings: [...aliasContext.warnings, ...warnings],
    aliasContext,
    effective,
  };
}

/**
 * Read-only census over the corpus. Returns:
 *  - Distinct keys + per-key claim counts (non-deprecated, valid at evaluationInstant;
 *    alias-shaped claims and flag artifacts excluded).
 *  - All key pairs scored by the registered rank fn, sorted desc, truncated to limit.
 *  - Resolved alias map, un-ratified self-aliases, and warnings.
 *  - Composed content with ready-to-paste remember ratification shape.
 *
 * Census never writes and never logs to the recall-log.
 */
export async function keyCensus(
  session: Session,
  args: CensusArgs & { corpus: string },
  deps: ReadDeps,
): Promise<CensusResult> {
  const corpus = args.corpus;
  const limit = args.limit ?? 20;
  const embeddings: EmbeddingState = deps.embeddings;

  const emptyResult: CensusResult = {
    corpus,
    keys: [],
    candidates: [],
    aliases: {},
    unratified: [],
    warnings: [],
    rankFn: embeddings.rankFn,
    content: "",
    cardinalityCollisions: [],
  };

  // Read-only: unknown corpus → empty report, no corpus created
  if (!session.listCorpora().some((c) => c.id === corpus)) {
    return emptyResult;
  }

  // ── Enumerate + score (shared core: single alias load, single now) ────────────
  const { entities, candidates, rankFn: effectiveRankFn, warnings, aliasContext, effective } = await censusCore(
    "key",
    session,
    corpus,
    deps,
    limit,
  );
  const { aliasMap, selfAliases } = aliasContext;

  // ── Cardinality safety check (best-effort; never throws into keyCensus) ───────
  // One extra lightweight query over the pre-⊥ (τ_valid + ⊕_dedupe) corpus — no
  // ranking/warm-up — so a single-cardinality key holding ≥2 distinct values is
  // surfaced as a mass-deprecation safety warning before ⊥ silently drops one.
  let collisions: CardinalityCollision[] = [];
  try {
    const now = Date.now(); // best-effort re-check; a fresh now is acceptable here
    const canon = canonicalReadStages({
      evaluationInstant: now,
      keyCardinality: effective,
      keyAliases: aliasMap,
      evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
    });
    const preContra = session.mneme.query<Corpus>(
      corpus,
      pipe(leaf(corpus), canon[0], canon[1]),
      { evaluationClock: now },
    );
    collisions = cardinalityCollisions(preContra, effective, aliasMap);
    warnings.push(...collisions.map(formatCardinalityCollision));
  } catch (e) {
    warnings.push(`cardinality-safety check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const keys = entities.map(({ value, claims }) => ({ key: value, claims }));

  // ── Composed content ──────────────────────────────────────────────────────────
  const lines: string[] = [
    `## Key Census: corpus "${corpus}"`,
    "",
    `**Keys (${keys.length}):**`,
  ];

  for (const { key, claims } of keys) {
    lines.push(`- \`${key}\`: ${claims} claim${claims !== 1 ? "s" : ""}`);
  }

  if (candidates.length > 0) {
    lines.push("", `**Top key-pair candidates (${candidates.length}):**`);
    for (const { a, b, score } of candidates) {
      lines.push(`- \`${a}\` ↔ \`${b}\`: ${score.toFixed(3)}`);
    }
  }

  if (Object.keys(aliasMap).length > 0) {
    lines.push("", "**Resolved aliases:**");
    for (const [variant, canonical] of Object.entries(aliasMap)) {
      lines.push(`- \`${variant}\` → \`${canonical}\``);
    }
  }

  if (selfAliases.length > 0) {
    lines.push("", `**Un-ratified self-aliases (${selfAliases.length}):** ${selfAliases.map((s) => `\`${s}\``).join(", ")}`);
  }

  // Ratification shape: paste-ready remember calls for top candidates
  if (candidates.length > 0) {
    lines.push("", "**Ratification shape** (paste into `remember` to confirm an alias):");
    const topCandidates = candidates.slice(0, 3);
    for (const { a, b } of topCandidates) {
      lines.push(`\`remember({ subject: "key:${a}", key: "alias-of", value: "${b}", corpus: "${corpus}" })\``);
    }
  }

  const content = lines.join("\n");

  return {
    corpus,
    keys,
    candidates,
    aliases: aliasMap,
    unratified: selfAliases,
    warnings,
    rankFn: effectiveRankFn,
    content,
    cardinalityCollisions: collisions,
  };
}

export interface SubjectCensusResult {
  corpus: string;
  subjects: { subject: string; claims: number }[];
  candidates: { a: string; b: string; score: number }[]; // sorted desc, truncated to limit
  rankFn: string;
  warnings: string[];
  content: string; // advisory-only text; no alias-of ratification shape
}

/**
 * Read-only census over the subject axis. Symmetric to keyCensus but the content
 * is ADVISORY ONLY — there is no subject-alias mechanism, so unlike keyCensus this
 * never composes a `remember(... alias-of ...)` ratification shape. Instead it
 * names near-duplicate subject pairs and points at `reconcile` as the ingest-time
 * fix for fragmented subjects.
 *
 * Census never writes and never logs to the recall-log.
 */
export async function subjectCensus(
  session: Session,
  args: CensusArgs & { corpus: string },
  deps: ReadDeps,
): Promise<SubjectCensusResult> {
  const corpus = args.corpus;
  const limit = args.limit ?? 20;
  const embeddings: EmbeddingState = deps.embeddings;

  const emptyResult: SubjectCensusResult = {
    corpus,
    subjects: [],
    candidates: [],
    rankFn: embeddings.rankFn,
    warnings: [],
    content: "",
  };

  // Read-only: unknown corpus → empty report, no corpus created
  if (!session.listCorpora().some((c) => c.id === corpus)) {
    return emptyResult;
  }

  const { entities, candidates, rankFn: effectiveRankFn, warnings } = await censusCore(
    "subject",
    session,
    corpus,
    deps,
    limit,
  );

  const subjects = entities.map(({ value, claims }) => ({ subject: value, claims }));

  // ── Composed content: advisory only, no alias-of ratification shape ───────────
  const lines: string[] = [
    `## Subject Census: corpus "${corpus}"`,
    "",
    `**Subjects (${subjects.length}):**`,
  ];

  for (const { subject, claims } of subjects) {
    lines.push(`- \`${subject}\`: ${claims} claim${claims !== 1 ? "s" : ""}`);
  }

  if (candidates.length > 0) {
    lines.push("", `**Top subject-pair candidates (${candidates.length}):**`);
    for (const { a, b, score } of candidates) {
      lines.push(`- \`${a}\` ↔ \`${b}\`: ${score.toFixed(3)}`);
    }
    lines.push(
      "",
      "These subjects look like they may refer to one entity. There is no subject-alias " +
        "mechanism — canonicalize at ingest time via `reconcile` instead of splitting claims " +
        "across near-duplicate subjects.",
    );
  }

  const content = lines.join("\n");

  return {
    corpus,
    subjects,
    candidates,
    rankFn: effectiveRankFn,
    warnings,
    content,
  };
}
