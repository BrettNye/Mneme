# Journal — Seeding the `adv-payroll` knowledge base (2026-06-08)

## What we did

Designed and seeded a Mneme corpus (`adv-payroll`) of federal Davis-Bacon certified-payroll
domain knowledge for internal CrewTracks feature-design reference — a dogfood exercise.

- **30 claims** across three layers: vocabulary (10), regulatory hot facts (12), operational
  pitfalls (8).
- Schema: typed-entity subjects + an 8-key controlled vocabulary; jurisdiction/authority on
  tags (`jur:federal`, `auth:DOL-WHD`); empty scope; `confidence:1` + `src:` on verified hot
  facts, `~0.8` on soft/conceptual claims.
- 12 hot facts verified against eCFR §§5.2/5.5/5.12/5.25/5.32 and the DOL WH-347 instructions.
  Two drafts were corrected by verification: debarment is a fixed **3-year** period (not "up
  to"); the **"within seven days"** submission window was dropped (removed in the 2023 DBRA
  revision).

Spec: `docs/superpowers/specs/2026-06-08-adv-payroll-knowledge-base-design.md`.
Plan: `docs/superpowers/plans/2026-06-08-adv-payroll-knowledge-base.md`.

## Mistakes made (and how they were caught)

### M1 — `scope: { jurisdiction, authority }` rejected by strict-scope
The first implementer subagent tried to write the spec's `scope` fields and every write was
refused: *"scope field 'jurisdiction' is not declared in the corpus schema (strict scope)."*
Auto-created corpora hardcode the scope schema to `{project, person, context}`; undeclared
fields are rejected. **Resolved:** carry jurisdiction/authority as tags (`jur:federal`,
`auth:DOL-WHD`); `tagIn` keeps them filterable. Documented as a pre-state-expansion migration
gate. (Memory: `mneme-mcp-scope-declaration-gap`.)

### M2 — three distinct facts collapsed under one `(subject, key)`
WH-347 Column 6, Column 7, and the Statement of Compliance were all written as
`form:wh-347` / `field-spec`. They share a `scopeHash` (empty scope), so combine/resolve
treated them as competing values of one claim and applied last-write-wins — Column 6 and
Column 7 were silently deprecated. **Caught by the verification gate:** `key_census` showed
`field-spec: 1` from 3 writes (28 claim-groups from 30 writes), and a subject+key-filtered
`recall` returned only the last value. **Resolved:** re-seed with distinct subjects
(`form:wh-347:column-6` / `:column-7` / `:statement-of-compliance`). Census now reads
`field-spec: 3`, 30 groups total. (Memory: `mneme-one-fact-per-subject-key`.)

### Process friction
- No hard delete by design → each fix required the founder to clear the store and re-seed
  (done twice). A throwaway test-write with `scope:{context:'federal'}` also had to be reset.
- One parallel write batch was interrupted mid-flight; 6/8 committed, resumed cleanly.

## Could better MCP tool descriptions have prevented these? (Yes — actionable)

Both mistakes trace to under-specified `remember` affordances. The current descriptions:

- `remember`: *"Store a typed claim (subject, key, value)… Use for durable facts, decisions,
  or context worth recalling later."*
- `scope`: *"optional scope fields for this claim, e.g. { project: 'mneme', context: 'prod' }"*

Neither surfaces the two behaviors that bit us. Proposed fixes, by leverage:

1. **Surface combine/resolve identity in the `remember` description (would have prevented M2).**
   State that claims are identified/grouped by `(subject, key, scope)` and that a repeat write
   to the same tuple combines/resolves — *a new value can supersede an earlier one*. Add a
   one-liner: "For facts that should coexist, use distinct subjects or keys." Nothing in the
   current text hints that two `remember` calls can silently collapse into one.

2. **Make the write response report supersession (the single highest-value fix).**
   `remember` currently returns `{ id, status: "committed", corpus }` — identical whether the
   write created a new claim or deprecated a prior one. If the response included
   `action: "new" | "combined" | "superseded"` and any `deprecatedIds`, M2 would have been
   visible at write time instead of only at the census gate. Silent supersession is the trap.

3. **Document strict-scope on the `scope` field, and list allowed fields in the error
   (would have prevented M1's flailing).** The `scope` description should say only fields
   declared in the corpus schema are accepted (auto-create allows `{project, person, context}`)
   and others are rejected. Better still: the rejection error should *enumerate the allowed
   fields* — ours said what was wrong but not what was valid, so the subagent guessed (and
   over-probed). Best: expose the declared scope schema via `list_corpora` or a
   `corpus_schema` read.

4. **Offer a corrective affordance (would have removed the reset friction).** Non-destructive
   storage is the wedge, but a `retract`/`supersede`/`correct` MCP tool (soft, replayable)
   would let a caller fix a mis-seed without the founder manually clearing the store. We reset
   twice for want of this.

### Takeaway
The algebra (combine/resolve, scopeHash grouping, strict scope) is the product's substance,
but it is **invisible at the MCP surface** — the tool descriptions read like a plain
key-value store, so a caller models accordingly and gets surprised by the algebra. Closing
items 1–2 (describe identity + report supersession in the response) is the cheapest, highest-
impact change; both of today's mistakes were latent in that gap.
