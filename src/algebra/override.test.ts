import { overrideOp, override } from "./override.js";
import { corpusOf } from "./types.js";
import { leaf, evaluate, pipe } from "./expression.js";

// Minimal claim fixture (mirrors combination.test.ts / expression.test.ts style).
const claim = (
  id: string,
  value: string,
  subject: string = "s",
  key: string = "s.k",
  scopeHash: string = "_"
) =>
  ({
    id,
    subject,
    key,
    scopeHash,
    value,
    source: "workflow",
    confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 },
    evidence: [],
    scope: {},
  }) as any;

// -------------------------------------------------------------------
// Dominator (left) wins on a matching (subject,key,scopeHash) triple
// -------------------------------------------------------------------
it("overrideOp: left dominates on a matching (subject,key,scopeHash) triple", () => {
  const left = corpusOf([claim("L", "left-wins", "s", "s.k", "_")]);
  const right = corpusOf([claim("R", "right-loses", "s", "s.k", "_")]);
  const out = overrideOp(left, right);
  expect(out.claims).toHaveLength(1);
  expect(out.claims[0].id).toBe("L");
  expect(out.claims[0].value).toBe("left-wins");
});

// -------------------------------------------------------------------
// Dominated (right) contributes triples the left does not address
// -------------------------------------------------------------------
it("overrideOp: right contributes claims for triples absent from left", () => {
  const left = corpusOf([claim("L", "x", "s1", "s1.k", "h1")]);
  const right = corpusOf([claim("R", "y", "s2", "s2.k", "h2")]);
  const out = overrideOp(left, right);
  expect(out.claims).toHaveLength(2);
  const ids = out.claims.map((c) => c.id).sort();
  expect(ids).toEqual(["L", "R"]);
});

// -------------------------------------------------------------------
// Left keeps ALL its claims for a contested triple; right's are dropped
// -------------------------------------------------------------------
it("overrideOp: keeps all of left's claims for a contested triple, drops right's", () => {
  const left = corpusOf([
    claim("L1", "a", "s", "s.k", "_"),
    claim("L2", "b", "s", "s.k", "_"),
  ]);
  const right = corpusOf([claim("R", "c", "s", "s.k", "_")]);
  const out = overrideOp(left, right);
  expect(out.claims).toHaveLength(2);
  const ids = out.claims.map((c) => c.id).sort();
  expect(ids).toEqual(["L1", "L2"]);
});

// -------------------------------------------------------------------
// Identity: C ⊳ ∅ = C
// -------------------------------------------------------------------
it("overrideOp: right identity — C ⊳ ∅ = C", () => {
  const c = corpusOf([claim("L", "x")]);
  const empty = corpusOf([]);
  const out = overrideOp(c, empty);
  expect(out.claims).toHaveLength(1);
  expect(out.claims[0].id).toBe("L");
});

// -------------------------------------------------------------------
// Identity: ∅ ⊳ C = C
// -------------------------------------------------------------------
it("overrideOp: left identity — ∅ ⊳ C = C", () => {
  const empty = corpusOf([]);
  const c = corpusOf([claim("R", "x")]);
  const out = overrideOp(empty, c);
  expect(out.claims).toHaveLength(1);
  expect(out.claims[0].id).toBe("R");
});

// -------------------------------------------------------------------
// Associative: (A ⊳ B) ⊳ C == A ⊳ (B ⊳ C)
// -------------------------------------------------------------------
it("overrideOp: associative — (A ⊳ B) ⊳ C equals A ⊳ (B ⊳ C)", () => {
  const a = corpusOf([claim("A", "a", "s", "s.k", "_")]); // contests triple T
  const b = corpusOf([
    claim("B", "b", "s", "s.k", "_"), // contests T (loses to A)
    claim("Bonly", "bo", "sb", "sb.k", "hb"), // unique triple
  ]);
  const c = corpusOf([
    claim("C", "c", "s", "s.k", "_"), // contests T (loses)
    claim("Bonly2", "bo2", "sb", "sb.k", "hb"), // contests Bonly's triple (loses to B)
    claim("Conly", "co", "sc", "sc.k", "hc"), // unique triple
  ]);

  const leftAssoc = overrideOp(overrideOp(a, b), c);
  const rightAssoc = overrideOp(a, overrideOp(b, c));

  const norm = (corpus: { claims: readonly any[] }) =>
    corpus.claims.map((cl) => cl.id).sort();
  expect(norm(leftAssoc)).toEqual(norm(rightAssoc));
  // On triple T, A wins in both groupings.
  expect(norm(leftAssoc)).toEqual(["A", "Bonly", "Conly"]);
});

// -------------------------------------------------------------------
// NOT commutative: A ⊳ B != B ⊳ A on a contested triple
// -------------------------------------------------------------------
it("overrideOp: NOT commutative — A ⊳ B differs from B ⊳ A on a contested triple", () => {
  const a = corpusOf([claim("A", "a", "s", "s.k", "_")]);
  const b = corpusOf([claim("B", "b", "s", "s.k", "_")]);
  const ab = overrideOp(a, b);
  const ba = overrideOp(b, a);
  expect(ab.claims[0].id).toBe("A");
  expect(ba.claims[0].id).toBe("B");
  expect(ab.claims[0].id).not.toBe(ba.claims[0].id);
});

// -------------------------------------------------------------------
// Stage builder: override(rightPipeline) evaluates the right operand as its
// own sub-pipeline in the same ctx, then applies left precedence.
// -------------------------------------------------------------------
it("override: Stage builder evaluates a right sub-pipeline and applies left precedence", () => {
  const leftClaim = claim("L", "left-wins", "s", "s.k", "_");
  const rightContested = claim("R", "right-loses", "s", "s.k", "_");
  const rightUnique = claim("U", "right-unique", "s2", "s2.k", "h2");

  const ctx = {
    adapter: {
      query: (plan: any) =>
        plan.corpusId === "left"
          ? [leftClaim]
          : [rightContested, rightUnique],
    } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };

  const out = evaluate<any>(
    pipe(leaf("left"), override([leaf("right")])),
    ctx
  );

  const ids = out.claims.map((c: any) => c.id).sort();
  // L wins the contested triple; U (unique to right) is contributed.
  expect(ids).toEqual(["L", "U"]);
});
