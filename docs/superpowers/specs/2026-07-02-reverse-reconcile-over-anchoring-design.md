# Reverse-reconcile — over-anchoring detection (design spec, 2026-07-02)

Status: **DRAFT / proposed.** Phase 1.5 of the ingest-loop SDK. Prompted by the real-LLM A/B on
2026-07-02 (`scripts/ab-ingest.ts`, recorded in the ingest-loop spec §4 "Validated limitation"):
a canon-informed extractor told to "prefer existing subjects" collapsed **17 genuinely distinct
entities into 2** — merging different people, dropping distinct clients, folding nine features into
one project. Today's `reconcile` guard did not fire.

## 1. Problem — the guard is one-directional

`reconcile` (and `subjectCensus`) detect **under-folding**: a candidate that is a near-duplicate of an
existing entity (`project:crewtracks` vs `project:crewTracks-liner-build`). They protect against
*minting a redundant subject*. They are blind to the opposite failure — **over-folding**: two
genuinely distinct entities collapsed onto ONE subject.

Critically, in the A/B the over-fold happened at **extraction**: the LLM returned already-canonical
subjects (`disposition: reuse`/exact), so the reconcile guard never saw the distinct entities to
protect them. **The reconcile guard protects the reconcile step, not the extractor.** Closing this
means detecting, after the fact, when one subject is holding claims that belong to multiple entities.

Symmetry to state plainly:

| failure | detector today | proposed |
|---|---|---|
| under-fold (fragmentation: 1 entity → N subjects) | `subjectCensus` / `reconcile` | (exists) |
| over-fold (over-anchoring: N entities → 1 subject) | **none** | **this spec** |

## 2. Goal

A **propose-only** (charter I3) detector that surfaces likely over-merged subjects so the
detect→declare→contest loop covers BOTH failure modes. It never auto-splits (subject splitting, like
subject merging, is deferred and human-gated). Output shape mirrors `AuditProposal` so it folds into
the existing `audit` report.

## 3. Three approaches (recommended split below)

### A. Subject-cohesion audit — cheap, in-corpus, no LLM (v1)

Symmetric to `subjectCensus`. For each subject, cluster its live claim VALUES by similarity (reuse the
`clustersOf`/entity-scorer primitive already behind census). Flag a subject when its values form
**≥2 well-separated clusters** (low cross-cluster similarity) above a claim-count floor — a signal it
may hold multiple entities.

- **Cost:** zero (in-corpus, jaccard/embeddings already available).
- **Honest weakness:** LOW PRECISION. A legitimate entity has diverse claims (a project has status +
  requirements + decisions); value diversity ≠ over-merge. This is a **high-recall / low-precision**
  starting point for human review, NOT a confident detector. It MUST be surfaced as such (the proposal
  `detail` says "possible over-merge — review," never "over-merged").

### B. Value→subject re-attribution check — single-pass, no extra LLM (v1, stronger signal)

At ingest time, after a claim `(S, V)` is written under a reused subject `S`, score `V`'s cohesion
against `S`'s existing value-set vs every OTHER live subject's value-set. If `V` coheres **more** with a
different subject `S'` (or with none), the attribution to `S` is suspect → flag `(claim, S, bestOther)`.

- **Cost:** one extra in-corpus scoring pass per reused claim (no LLM).
- **Weakness:** relies on value-cohesion being meaningful across subjects; noisy on short values. Better
  than A because it is per-claim and directional, but still heuristic.

### C. Dual-pass shadow extraction — strong, opt-in, 2× LLM cost (the real fix)

The over-fold is created at extraction, so only a second, **blind** extraction reveals the entities the
LLM would have minted. Run extraction twice — blind (no canon) and canon-informed — and reconcile the
two outputs. When a blind-pass subject maps onto a **different** canon subject in the informed pass,
that pair is a candidate over-fold. This is the A/B itself, turned into a guard.

- **Cost:** doubles extraction LLM spend. Opt-in high-assurance mode only.
- **Strength:** directly targets the failure mode with the only signal that actually contains it (the
  counterfactual distinct entities). Highest precision of the three.

## 4. Recommendation

- **v1 (this spec's build target):** approach **B** as a new op `reverseReconcile(session, {corpus}, deps)`
  → over-fold proposals, wired into `audit` alongside the existing kinds, plus approach **A** as a
  cheap corpus-wide `subjectSplitCensus` extension of `subjectCensus`. Both propose-only, both
  explicitly labelled low/medium-confidence.
- **Escalation (documented, deferred):** approach **C** as an opt-in `ingest` dial
  (`shadowExtract: true`) — cost-gated, the confident detector when the cheap signals flag something.
- **Immediate mitigation (already shipped as guidance, no build):** the injected extractor prompt MUST
  say *"reuse only for the SAME entity, mint anything genuinely new"* — never *"prefer existing."* This
  alone would have prevented most of the A/B damage; the detectors are the backstop, not the primary
  defense.

## 5. Surface (v1 — approach B + A)

```ts
export interface OverFoldProposal {
  kind: "subject-over-merge";
  subject: string;              // the over-anchored subject
  claim?: string;               // (approach B) the specific suspect claim id
  betterSubject?: string;       // (approach B) the subject its value coheres with more
  cohesion?: number;            // score gap driving the flag
  confidence: "low" | "medium"; // A = low, B = medium — NEVER "high" (heuristic)
  detail: string;               // "possible over-merge — review", never asserted
}

export async function reverseReconcile(
  session: Session, args: { corpus: string; minClaims?: number }, deps: ReadDeps,
): Promise<{ corpus: string; proposals: OverFoldProposal[]; rankFn: string; content: string }>;
```

Wire into `audit`: `audit`'s `proposals` gains `subject-over-merge` entries (ranked below the existing
high-confidence kinds). `ingest`'s report can optionally run it post-write so an over-anchored batch is
flagged in the same pass.

## 6. Invariants

- **I3 propose-never-apply** — no auto-split, ever. Splitting a subject is a destructive-shaped edit;
  it stays human-gated (consistent with subject-MERGE also being deferred).
- **Confidence honesty** — proposals are `low`/`medium` only; the API type forbids `high`. "Fewer
  subjects is good" is a banned framing (the A/B disproved it) — proposals speak to *entity distinctness*,
  not subject count.
- **Deterministic + offline (A and B)** — jaccard deps + fixed corpus → deterministic; testable via a
  `validate-reverse-reconcile.ts` harness seeded with a known over-merged subject.

## 7. Testing

`scripts/validate-reverse-reconcile.ts` (offline, jaccard, no LLM): seed a corpus with a subject
holding two token-disjoint value clusters (e.g. `project:x` carrying both payroll-export claims and
geofencing claims) plus a control subject with cohesive values; assert `reverseReconcile` flags the
former, not the latter, and that it performs NO writes (I3). Plus unit tests for the empty/unknown-corpus
and single-cluster (no-flag) paths.

## 8. Out of scope

- Auto-splitting subjects (deferred, human-gated — symmetric to deferred subject-merge).
- Approach C's dual-pass mode (documented escalation; cost-gated, built only if A/B signals prove
  insufficient in practice).
- Fixing the extractor prompt — that lives in the CONSUMER's injected `extract`, not the SDK (the SDK's
  `canonPrompt` should carry the corrected "same→reuse, new→mint" framing, tracked with the ingest spec).

## 9. Delivery

Small, composition-first, offline-testable, symmetric to the shipped `subjectCensus`/`reconcile`.
Suitable for a short DAG plan: [T1 `reverseReconcile` op + `OverFoldProposal`] → [T2 wire into `audit`]
+ [T3 `validate-reverse-reconcile.ts`] → [T4 unit tests]. Approach C is a separate later effort.
