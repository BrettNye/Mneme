# Ingest-loop SDK — design spec (2026-07-02)

Status: **DRAFT / proposed.** Owner: ingestion boundary. Prompted by the 2026-07-01
Fireflies→Mneme dogfood (`rastate/synthesis-fireflies-dogfood-synthesis-ingestion`,
`rastate/decision-2026-07-01-memory-informed-extraction-ingest-with`) and the follow-up
analysis that ingestion — not the algebra — is Mneme's bottleneck.

## 1. Problem

The dogfood's #1 durable lesson: **recall-before-write must be applied at *ingestion*, not
just serving.** Feeding meeting-1's canonical subjects into meeting-2's extractor turned
0/26 entity reuse into 18/18 and made supersession fire. But that loop
(`gather canon → extract WITH canon → reconcile → supersession-aware write → report`) is
currently **hand-rolled by every consumer** (the untracked `scripts/run-fireflies*.ts`,
`examples/fireflies-ingest.ts`). Every consumer re-derives it, and left to discretion an
agent will skip it and canonicalize blind — exactly the failure the decision doc forbids
("never let the extractor canonicalize blind").

The shipped primitives already exist — `reconcile`, `keyCensus`/`subjectCensus`, `audit`,
supersession-aware `remember`, `declareCardinality`, `distinctEntities`. What's missing is
**one composition that wires them into the enforced loop** and returns a structured
per-claim disposition report. This is a pure composition (no new algebra), consistent with
`mneme-composition-first-principle`.

## 2. The driver question: is MCP-driven enough, or is an in-between needed?

Both. They are the same loop with two drivers, and each is right for a different caller.

- **Interactive, agent-in-the-loop, low volume → raw MCP is sufficient.** An agent reading a
  transcript in-context *can* recall/reconcile before it calls `remember`, and
  `MNEME_WRITE_SCHEMA` + the server instructions nudge it to. Adding a layer here is
  over-engineering. The limitation is *reliability*, not capability: the loop is advisory,
  and a distractible agent skips reconcile or ignores the cardinality warning.

- **Programmatic / batch / headless callers → they need the in-between.** RaState's
  ReadingRoom (Mneme *is* its Layer-5 ingestion engine), the reporting MCP, a nightly
  transcript job — none of these reason per-item in an agent turn. They need a *library call*
  that (a) makes the recall-before-write loop **structural, not discretionary**, (b) closes
  the crucial feedback edge — canonical entities injected **into** the extraction step, not
  reconciled after the fact, and (c) returns an aggregated, auditable disposition report.

**Design resolution:** build the loop **once as an SDK primitive** (`ingest`), then expose it
three ways — a library call (RaState/reporting MCP), an *optional* `ingest` MCP tool for
agents who want the loop enforced in a single call, and the existing fine-grained tools left
untouched for interactive control. The SDK is the primitive; the drivers are thin.

There is a subtle asymmetry worth stating: the canon-into-extraction edge (steps 1–2 below)
only matters when the SDK *owns* extraction. When an agent extracts in-context and drives the
MCP, it obtained canon via its own `recall`/`reconcile` calls, so the MCP `ingest` tool only
needs steps 3–6 over agent-supplied candidates ("reconcile-and-commit a batch").

## 3. Public surface

`src/surface/ingest.ts`, exported from `src/surface/index.ts`. Signature matches the existing
`(session, args, deps)` shape of `reconcile`/`recall`/`audit`.

```ts
export async function ingest(
  session: Session,
  args: IngestArgs,
  deps: ReadDeps,
): Promise<IngestReport>;

export interface IngestArgs {
  corpus: string;
  /**
   * The source-shaped extraction step. Receives the corpus's LIVE canonical entities so it
   * can reuse them DURING extraction (recall-before-write). If the caller already has
   * structured candidates (no LLM), it ignores ctx and returns them.
   */
  extract: (ctx: IngestContext) => CandidateClaim[] | Promise<CandidateClaim[]>;
  /** Score >= this → auto-remap candidate to the canonical entity. Default 0.9 (reconcile's). */
  reuseThreshold?: number;
  /** Score <= this → treat as genuinely new. Default 0.5 (reconcile's). */
  newThreshold?: number;
  /** Apply cardinality-declare proposals automatically. Default false (charter I3: propose-only). */
  autoDeclareCardinality?: boolean;
  /** Extract + reconcile + plan, write NOTHING. Default false. */
  dryRun?: boolean;
}

export interface IngestContext {
  corpus: string;
  canonicalSubjects: string[]; // live distinct subjects (subjectCensus)
  canonicalKeys: string[];     // live distinct keys (keyCensus)
  /** Preformatted block to drop into an LLM extractor prompt (reuse-when-same, mint-when-new). */
  canonPrompt: string;
}

export interface CandidateClaim {
  subject: string;
  key: string;
  value: string;
  validFrom?: string;                  // ISO-8601; explicit ⇒ deterministic supersession
  confidence?: number;
  tags?: string[];
  scope?: Record<string, string>;
}

export interface IngestedClaim {
  candidate: CandidateClaim;
  subject: { final: string; disposition: ReconcileDisposition; remappedFrom?: string };
  key:     { final: string; disposition: ReconcileDisposition; remappedFrom?: string };
  write?: { id: string; status: string; supersession?: SupersessionOutcome }; // absent when dryRun
}

export interface IngestReport {
  corpus: string;
  dryRun: boolean;
  claims: IngestedClaim[];
  counts: {
    extracted: number;
    reusedSubjects: number;
    mintedSubjects: number;
    uncertain: number;    // borderline entity matches the loop refused to auto-fold
    superseded: number;
    duplicates: number;   // ⊕_dedupe absorbed / write status !== "committed"
    written: number;
  };
  proposals: AuditProposal[]; // cardinality-declare / key-alias / subject-fragmentation — NEVER auto-applied unless flagged
  rankFn: string;
  warnings: string[];
  content: string;            // human-readable report, mirrors reconcile/audit .content
}
```

Reused types (no new ones invented): `ReconcileDisposition`, `SupersessionOutcome`,
`AuditProposal`, `ReadDeps`.

## 4. Algorithm (composition of shipped primitives)

1. **Gather canon (unknown corpus is not an error — this is a WRITE path).** Unlike the read-only
   `audit`/`reconcile` guard, `ingest` still runs `extract` on an unknown corpus (canon is empty →
   every disposition is `new`), and the first `remember` auto-creates the corpus via `ensureCorpus`.
   This is deliberate: ingesting into a not-yet-existing corpus is the common first-ingest case, and
   `dryRun` still writes nothing so a preview never vivifies. On a known corpus, enumerate live
   distinct entities: `canonicalSubjects = subjectCensus(...).subjects.map(s => s.subject)`,
   `canonicalKeys = keyCensus(...).keys.map(k => k.key)`. Build `canonPrompt`.
2. **Extract WITH canon.** `candidates = await extract(ctx)`. This is the recall-before-write
   edge: the extractor sees canon and reuses it. If `candidates` is empty → report and return.
3. **Reconcile.** `reconcile(session, { corpus, subjects: distinct(candidate.subject),
   keys: distinct(candidate.key), reuseThreshold, newThreshold }, deps)`. Build a
   candidate→disposition map on each axis.
4. **Remap (over-anchoring guard).** For each candidate: if its subject/key disposition is
   `reuse` → remap to `suggestions[0].existing` (record `remappedFrom`). If `uncertain` →
   **do NOT remap** (mint as-is, count in `uncertain`, surface for ratify). If `new` → mint.
   *This is strictly safer than the dogfood's prompt-level "prefer existing," which
   over-anchored `traffic-control` into `liner-division`: the SDK auto-folds only ≥threshold
   matches and routes the borderline to detect→declare→contest.*
5. **Write (unless dryRun).** `remember(session, { ...remapped, corpus })` per candidate;
   capture `supersession`. Roll up superseded / duplicates / written from each outcome.
6. **Propose (never apply).** `audit(session, { corpus }, deps)` → `proposals`
   (cardinality-declare, key-alias, subject-fragmentation). If `autoDeclareCardinality` →
   apply ONLY the `cardinality-declare` proposals via `session.declareCardinality`
   (subject/key aliases are NEVER auto-applied — deferred, gated on demand). Assemble `content`.

Non-destructive ordering note: because writes only *deprecate at serve time* (claims retained),
declaring `multi` *after* a write cleanly un-deprecates — so proposing cardinality post-write is
safe (this is exactly validated effect A: single→1 warned, declare multi→both served).

## 5. Invariants (inherit the belief-change charter)

- **I1 non-destructive** — every write is supersession-aware; nothing deleted.
- **I3 propose-never-apply** — `uncertain` entity merges and `cardinality-declare` proposals are
  reported, not applied, unless the caller opts in (`autoDeclareCardinality`); subject merges are
  never auto-applied.
- **Deterministic + offline** — with `{ embeddings: { rankFn: "jaccard" } }` and a pure `extract`
  callback returning fixed candidates, the whole loop is deterministic and LLM-free (the extractor
  is the ONLY non-deterministic seam, and it is injected — so tests pass a fixed one).
- **Idempotent / safely re-runnable** — re-ingesting the same batch: `⊕_dedupe` absorbs exact
  repeats, supersession handles changed values; no duplicate accretion, no rollback needed.

## 6. Dials & defaults

- `reuseThreshold` 0.9 / `newThreshold` 0.5 — inherited from `reconcile` (provisional,
  uncalibrated; calibration is a deferred bench arm, tracked with the reconcile thresholds).
- `autoDeclareCardinality` false — safe default; multi-valued predicate corpora can opt in.
- `dryRun` false — set true to preview canonicalization before committing (ideal for the
  reporting MCP / a RaState ingest preview).

## 7. Edge cases

- Unknown corpus → `extract` still runs (canon empty, all dispositions `new`); the first non-dryRun
  `remember` auto-creates the corpus via `ensureCorpus` (ingest is a write path, not a read guard).
  A `dryRun` on an unknown corpus writes nothing and creates nothing.
- `extract` throws → propagate; nothing written before extraction completes, so no partial state.
- `extract` returns [] → report with `extracted: 0`, no writes.
- A candidate whose subject is `reuse` but key is `uncertain` (or vice-versa) → each axis remaps
  independently; the claim is written under (remapped-subject, minted-key) and both dispositions
  are recorded.
- `validFrom` omitted on a candidate → defaults to now (per `remember`); the spec RECOMMENDS
  callers pass explicit increasing `validFrom` for deterministic supersession (equal `valid.from`
  = tie = neither deprecated, a known flake source).

## 8. Optional MCP surface (phase 2)

Expose `ingest` as an MCP tool for agents who want the enforced loop in one call. Because the
agent has already extracted in-context, the tool takes **pre-structured candidates** and runs
steps 3–6 only (reconcile-remap → cardinality guard → supersession-aware write → report). Shape:
`ingest({ corpus, claims: CandidateClaim[], dryRun?, autoDeclareCardinality? })`. This is
"reconcile-and-commit a batch with a disposition report" — strictly more than looping `remember`,
and it makes the loop non-skippable. The existing fine-grained tools stay for interactive control.

## 9. Testing plan

`scripts/validate-ingest.ts` — a third durable offline harness alongside
`validate-shipped-dogfood.ts` and `validate-belief-change.ts` (same temp-DB, jaccard-deps style),
with a **pure `extract` callback** (no LLM). Assert, with explicit increasing `validFrom` and
distinct alpha/bravo/gamma tokens:
- **Reuse-remap** — a candidate subject that exactly matches a live canonical subject is written
  under the canonical subject (`remappedFrom` set), not minted.
- **Over-anchoring guard** — a genuinely-distinct candidate (no shared tokens) lands `new`/
  `uncertain` and is NOT folded.
- **Supersession** — a second distinct value under a single-cardinality key reports
  `supersession.action === "superseded"` with the older id.
- **Propose-only** — `dryRun` writes nothing (claim count unchanged) yet returns proposals;
  `autoDeclareCardinality:false` leaves schema untouched.
- **Idempotence** — running the same batch twice does not double the claim count.

Plus unit tests in `src/surface/ingest.test.ts` for the guard/empty/throw paths, and a
full-suite + `tsc --noEmit` gate.

## 10. Out of scope

- LLM extractors / source-specific adapters — those stay in the **consumer** (injected `extract`),
  never in Mneme's core (positioning: `mneme-positioning-wedge` — ingestion is table stakes; the
  wedge is the non-destructive/replayable substrate). `examples/fireflies-ingest.ts` remains an
  example, not a core surface.
- Post-hoc subject merging / subject-aliases — deferred, gated on demand (per Cluster B).
- Threshold calibration — the deferred reconcile bench arm.

## 11. Delivery

Phase 1 (SDK): `ingest.ts` + export + `validate-ingest.ts` + unit tests. Small, on-wedge,
composition-only, offline-testable. Phase 2 (optional): the `ingest` MCP tool. Suitable for a
short DAG plan (`writing-dag-plans`) — roughly: [T1 ingest.ts core] → [T2 export + types] +
[T3 validate-ingest.ts] → [T4 unit tests] → [T5 optional MCP tool].
