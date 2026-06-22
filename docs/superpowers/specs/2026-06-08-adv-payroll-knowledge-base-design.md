# Design: `adv-payroll` Knowledge Base — Federal Davis-Bacon Certified-Payroll Slice

**Date:** 2026-06-08
**Author:** Brett (CrewTracks analytics/reporting) + Claude
**Status:** Design — approved for spec write, pending user review

## Purpose

Curate a Mneme corpus of complex prevailing-wage / Davis-Bacon domain knowledge that
the CrewTracks analytics & reporting team references **internally** when designing
supporting features. The KB holds the *domain knowledge itself*; the bridge from
regulation to specific feature decisions stays with the human during design (it is
deliberately **not** encoded as claims, so the corpus stays durable as the product
changes).

This document specifies the first **thin vertical slice**: federal Davis-Bacon
certified payroll. It establishes schema conventions reusable when the corpus later
expands to state laws and union concepts.

### Success criteria

- A `recall` against the corpus answers the real prevailing-wage questions that come up
  while designing a reporting feature, with visible source/confidence so the designer
  knows how much to trust each claim.
- The claim schema survives a `key_census` audit (no key proliferation) and generalizes
  to state expansion without rework.

## Scope

**In:**
- Federal Davis-Bacon certified-payroll slice (~30–50 claims).
- Three knowledge layers: regulatory facts, operational know-how, domain vocabulary.
- Schema conventions (subject/key taxonomy, scope/tags/confidence/validFrom usage).
- The seed-claim list.
- A post-write verification gate.

**Out (deferred):**
- State "Little Davis-Bacon" laws and state-by-state rate determinations.
- Union / CBA specifics.
- Product-design-implication claims ("because rule X, our report needs field Y").
- Any customer-facing packaging or legally-defensible sourcing.

## Knowledge model (Approach A: typed-entity subjects + controlled key vocabulary)

### `subject` — typed entities
Prefix every subject with a type so related claims cluster and recall stays clean:

- `term:<slug>` — vocabulary entities, e.g. `term:prevailing-wage`
- `concept:<slug>` — broader concepts, e.g. `concept:davis-bacon`
- `form:<slug>` — forms/artifacts, e.g. `form:wh-347`
- `rule:<slug>` — specific rules/mechanics, e.g. `rule:fringe-credit`
- `pitfall:<slug>` — operational failure modes, e.g. `pitfall:fringe-cash-vs-plan`
- Compound subjects for the distinct parts of one artifact: `form:wh-347:column-6`, `form:wh-347:column-7`, `form:wh-347:statement-of-compliance` — see the one-fact rule below.

> **Claim identity — one fact per `(subject, key, scope)`.** Mneme groups claims by the tuple `(subject, key, scopeHash)` and applies combine/resolve to a group. Writing several *different* facts under the **same** `(subject, key)` (with empty scope they share a `scopeHash`) makes later writes supersede earlier ones via `resolveDeprecateOlder` — the earlier facts silently drop out of active recall. So each distinct fact MUST get a distinct subject (or key). This is why the three WH-347 facts are modeled as `form:wh-347:column-6` / `:column-7` / `:statement-of-compliance` rather than three `form:wh-347` / `field-spec` writes. (Same mechanism as the cross-jurisdiction collision in the scope note below — it just fires within one scope when subject+key is overloaded.) Detection: after seeding, `key_census` claim-count per key must equal the number of distinct facts written under it.

### `key` — controlled predicate vocabulary (~8)
Use ONLY these keys. Adding a key requires a deliberate decision (and a `key_census`
re-check):

- `definition` — what a term/concept means
- `requirement` — what a rule mandates
- `coverage` — when a rule applies (trigger/threshold conditions in prose)
- `field-spec` — specifics of a form field/column
- `threshold` — a numeric trigger or limit (dollar amount, ratio)
- `pitfall` — a common mistake / failure mode
- `relates-to` — an edge in the concept map (value names the related entity + the relationship)
- `rationale` — why a rule exists / the intent behind it

### Orthogonal axes

| Field | Carries | Example |
|---|---|---|
| `tags` | **jurisdiction** + **authority** + **layer** + **source** + **topic** | `['jur:federal', 'auth:DOL-WHD', 'regulatory', 'src:29CFR5.5', 'fringe']` |
| `confidence` | trust signal | `1` = verified hot fact · `~0.8` = soft/conceptual |
| `validFrom` | effective date — only when a fact has one | thresholds, rule changes |

> **Jurisdiction/authority ride on `tags`, not `scope` — forced by an MCP-surface gap, and this slice's hard prerequisite before state expansion.** The MCP can't declare custom scope fields: a freshly auto-created corpus gets a hardcoded `{project, person, context}` schema (`src/mcp/tools.ts` `ensureCorpus`), and strict-scope (`src/catalog/schema.ts` `validateScope`) rejects any undeclared field, so a `scope: { jurisdiction, authority }` write is refused. Tags work (`jur:federal`, `auth:DOL-WHD`) and `tagIn` is a real σ predicate, so jurisdiction stays filterable. **But tags are not a substitute for scope past one jurisdiction:** contradiction grouping keys on `(subject, key, scopeHash)` (`src/algebra/contradiction.ts`), *not* tags. With every claim at empty scope, a future state's differing value for the same `(subject, key)` would collide with the federal one in the same cluster and `resolveDeprecateOlder` would silently deprecate the older true claim. Semantic note: `jurisdiction` is a genuine truth-partitioning dimension → it *wants* scope; `authority` is provenance → tag is its correct home regardless. **Gate before adding any second jurisdiction:** add a `create_corpus`/`declare_scope` MCP tool forwarding `scopeFields` to core `createCorpus`, then migrate the federal claims to carry `jurisdiction: federal` scope (they're currently in the `"_"` empty-scope bucket). See memory `mneme-mcp-scope-declaration-gap`.

- **Jurisdiction tag** (exactly one per claim): `jur:federal` (only value in this slice).
- **Authority tag** (`auth:<body>`): the issuing authority, e.g. `auth:DOL-WHD`.
- **Layer tag** (exactly one per claim): `regulatory` | `operational` | `vocabulary`.
- **Source tag** (`src:<ref>`): present iff the claim was verified against an
  authoritative source.
- **Topic tags** (0+): `certified-payroll`, `fringe`, `apprenticeship`, `overtime`,
  `coverage`, etc.

**Corpus id:** `adv-payroll` (isolated from the default `knowledge` corpus).

### Example claims

```
subject: term:prevailing-wage        key: definition
value:   "The basic hourly rate + fringe benefits paid to the majority of workers in a
          given classification and locality, as determined by DOL."
tags: [jur:federal, auth:DOL-WHD, vocabulary]                   confidence: 0.9

subject: form:wh-347:column-6        key: field-spec
value:   "Column 6 (Rate of Pay) shows the straight-time rate plus any cash paid in lieu
          of fringe, e.g. '$12.25/.40'."
tags: [jur:federal, auth:DOL-WHD, regulatory, src:DOL-WH347-instructions, certified-payroll, fringe]   confidence: 1
# (Column 7 and the Statement of Compliance are SEPARATE claims under
#  form:wh-347:column-7 and form:wh-347:statement-of-compliance — one fact per subject+key.)

subject: pitfall:fringe-cash-vs-plan key: pitfall
value:   "Contractors commonly misreport bona-fide fringe contributions as cash wages,
          inflating gross and miscalculating the overtime base."
tags: [operational, fringe]          confidence: 0.8

subject: rule:fringe-credit          key: relates-to
value:   "concept:davis-bacon — fringe credit lets an employer meet the prevailing total
          by combining cash wage + benefit contributions."
tags: [regulatory, fringe]           confidence: 0.85
```

## Authoring & verification workflow (hybrid)

1. **Draft** the full slice (~30–50 claims) from domain knowledge, each pre-tagged with
   its layer + topic and a provisional confidence.
2. **Classify** each claim as a **hot fact** (exact WH-347 fields, fringe-credit
   mechanics, the $2,000 DBA contract threshold, apprentice ratios, overtime base rules)
   or **soft/conceptual** (definitions, relationships, pitfalls).
3. **Verify hot facts** against an authoritative source (eCFR 29 CFR Part 5; DOL/WHD
   WH-347 instructions) → set `confidence: 1` and add a `src:` tag. Soft claims stay
   `~0.8`, unsourced.
4. **Write** claims into the `adv-payroll` corpus via `remember`.

## Consumption pattern

```
recall(about="how should fringe be tracked separately on certified payroll?",
       corpus="adv-payroll", relevanceFloor=0.3)
```
Returns top-matching claims with confidence, composed into a token-bounded context.
The `relevanceFloor` / `abstainBelowTop` knobs tune precision once recall quality is felt
in real use (feeds the active dogfood window).

## Verification gate (after writing)

- `key_census(corpus="adv-payroll")` — confirm only the controlled key vocabulary was
  used; no accidental proliferation.
- Run 4–5 representative `recall` queries that mirror real design questions; confirm the
  slice actually answers them and that hot facts surface with `confidence: 1` + `src:`.

## Future expansion (out of scope here, but the schema supports it)

- State laws: **blocked on the scope-declaration gate above** — first add the
  `create_corpus`/`declare_scope` MCP tool and migrate federal claims to
  `scope.jurisdiction = 'federal'`, then set `scope.jurisdiction` to the state and add
  `src:` for state determinations. (Filtering federal-only data in the meantime is fine
  via the `jur:federal` tag; the gate exists only because a second jurisdiction would
  otherwise collide in contradiction grouping.)
- Union/CBA: add `concept:` / `rule:` entities; topic tag `union`.
- Product-design implications: if ever wanted, a separate corpus or a distinct
  layer tag — kept out of this domain corpus by design.
