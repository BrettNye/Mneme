# adv-payroll Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed the `adv-payroll` Mneme corpus with ~30 curated claims covering the federal Davis-Bacon certified-payroll slice across three layers (vocabulary, regulatory, operational), with hot facts verified against authoritative sources.

**Architecture:** Claims are `(subject, key, value)` triples written via the `mcp__mneme__remember` tool into corpus `adv-payroll`. Subjects use typed prefixes (`term:`/`concept:`/`form:`/`rule:`/`pitfall:`); keys are drawn from a fixed 8-key vocabulary. The test harness is `mcp__mneme__recall` (does a real design question get answered?) and `mcp__mneme__key_census` (did key proliferation stay zero?). Hot facts are verified against eCFR 29 CFR Part 5 and DOL WH-347 instructions via WebFetch/WebSearch before being written at `confidence: 1` with a `src:` tag.

**Tech Stack:** Mneme MCP tools (`remember`, `recall`, `key_census`), WebFetch/WebSearch for source verification.

**Conventions (from spec):**
- Controlled keys: `definition`, `requirement`, `coverage`, `field-spec`, `threshold`, `pitfall`, `relates-to`, `rationale`. Do NOT introduce others.
- **One fact per `(subject, key, scope)`:** distinct facts need distinct subjects (e.g. `form:wh-347:column-6` vs `:column-7`). Writing multiple facts under the same subject+key makes combine/resolve keep only the last (silent deprecation). Verify with `key_census`: claims-per-key must equal the distinct facts written under it.
- Every claim gets exactly one layer tag: `regulatory` | `operational` | `vocabulary`.
- Jurisdiction/authority go on **`tags`**, not `scope`: add `jur:federal` and `auth:DOL-WHD` to every claim's tag list. (The MCP can't declare custom scope fields — a `scope: {...}` write is rejected by strict-scope; see the spec's "Orthogonal axes" note and memory `mneme-mcp-scope-declaration-gap`. `scope` is left empty in this slice.)
- Verified hot facts: `confidence: 1` + a `src:` tag. Soft/conceptual claims: `confidence` 0.8–0.9, no `src:`.

---

### Task 1: Establish the failing recall baseline

**Files:** none (live corpus `adv-payroll`).

- [ ] **Step 1: Confirm the corpus is empty / nonexistent**

Call: `mcp__mneme__list_corpora`
Expected: `adv-payroll` not present (only `knowledge`, `smoke-test-a`, `smoke-test-b`).

- [ ] **Step 2: Run the baseline recall (should return nothing useful)**

Call: `mcp__mneme__recall` with `{ about: "how is fringe tracked separately on certified payroll?", corpus: "adv-payroll" }`
Expected: empty / no matches (corpus has no claims yet). This is the failing test the seed claims must satisfy.

---

### Task 2: Vocabulary & concept-map layer (~10 soft claims)

**Files:** none (writes to `adv-payroll`).

Each step is one `mcp__mneme__remember` call. Common fields for every claim in this task: `corpus: "adv-payroll"`, tags include `jur:federal` + `auth:DOL-WHD` + layer tag `vocabulary` (no `scope` — see Conventions).

- [ ] **Step 1: Write the core definitions**

```
remember(subject="term:prevailing-wage", key="definition",
  value="The basic hourly rate of pay plus fringe benefits paid to the majority of workers in a particular labor classification within a specific locality, as determined by the DOL.",
  tags=["vocabulary"], confidence=0.9)

remember(subject="concept:davis-bacon", key="definition",
  value="The Davis-Bacon Act (1931) requires contractors on federally funded or assisted construction contracts over $2,000 to pay laborers and mechanics no less than locally prevailing wages and fringe benefits.",
  tags=["vocabulary"], confidence=0.9)

remember(subject="concept:dbra", key="definition",
  value="Davis-Bacon and Related Acts (DBRA): the Davis-Bacon Act plus ~60 related statutes that extend prevailing-wage requirements to federally assisted projects (e.g. highways, housing).",
  tags=["vocabulary"], confidence=0.85)

remember(subject="concept:little-davis-bacon", key="definition",
  value="State-level prevailing-wage laws that mirror federal Davis-Bacon for state/locally funded public works. Out of scope for this federal slice but defined for disambiguation.",
  tags=["vocabulary"], confidence=0.85)

remember(subject="term:certified-payroll", key="definition",
  value="A weekly payroll report submitted by contractors on covered projects certifying that workers were paid the required prevailing wages; federally submitted on Form WH-347.",
  tags=["vocabulary"], confidence=0.9)

remember(subject="form:wh-347", key="definition",
  value="The DOL/WHD optional form used to submit weekly certified payroll for Davis-Bacon-covered federal projects, including the Statement of Compliance on page 2.",
  tags=["vocabulary"], confidence=0.9)

remember(subject="term:fringe-benefits", key="definition",
  value="The benefit portion of the prevailing wage (health, pension, vacation, training, etc.) that may be paid into bona-fide plans or as cash to the worker.",
  tags=["vocabulary"], confidence=0.9)

remember(subject="term:labor-classification", key="definition",
  value="The work classification (e.g. Electrician, Carpenter, Laborer Group 1) that determines which prevailing wage rate applies to a worker; set by the applicable wage determination.",
  tags=["vocabulary"], confidence=0.9)

remember(subject="term:wage-determination", key="definition",
  value="A DOL-issued schedule listing the minimum prevailing wage and fringe rates by labor classification for a locality and construction type; incorporated into the contract.",
  tags=["vocabulary"], confidence=0.9)
```

- [ ] **Step 2: Write the concept-map edges (`relates-to`)**

```
remember(subject="rule:fringe-credit", key="relates-to",
  value="concept:davis-bacon — fringe credit lets an employer meet the required prevailing total by combining cash wages plus bona-fide fringe contributions.",
  tags=["vocabulary", "fringe"], confidence=0.85)
```

- [ ] **Step 3: Verify the vocabulary layer recalls**

Call: `mcp__mneme__recall` with `{ about: "what is the difference between prevailing wage and davis-bacon?", corpus: "adv-payroll", relevanceFloor: 0.3 }`
Expected: `term:prevailing-wage` and `concept:davis-bacon` definitions surface in the top matches.

---

### Task 3: Regulatory hot-fact layer (~12 claims) — verify before writing

**Files:** none (writes to `adv-payroll`).

These are HOT FACTS. For each, the draft value below is a starting point — **verify against a source before writing**, then write with `confidence: 1` and the appropriate `src:` tag. Common fields: `corpus: "adv-payroll"`, tags include `jur:federal` + `auth:DOL-WHD` + layer tag `regulatory` (no `scope` — see Conventions).

- [ ] **Step 1: Fetch the authoritative sources**

Use WebFetch/WebSearch on:
- eCFR 29 CFR Part 5 (`https://www.ecfr.gov/current/title-29/subtitle-A/part-5`) — coverage, fringe credit, overtime, apprentices.
- DOL/WHD WH-347 instructions (`https://www.dol.gov/agencies/whd/forms/wh347`) — form field specs and Statement of Compliance.
Record the exact section/page each verified fact comes from for the `src:` tag.

- [ ] **Step 2: Write the coverage & threshold claims (after verifying values)**

```
remember(subject="concept:davis-bacon", key="threshold",
  value="Davis-Bacon applies to federal or federally-assisted construction contracts in excess of $2,000. The threshold is measured on the prime contract; covered subcontractors are bound regardless of their subcontract size.",
  tags=["regulatory", "src:40USC3142", "coverage"], confidence=1)

remember(subject="rule:dbra-coverage", key="coverage",
  value="Covers laborers and mechanics (manual/physical workers, including apprentices and helpers) employed on the 'site of the work'; excludes those whose duties are primarily administrative, executive, or clerical, and bona-fide material suppliers whose facilities pre-exist the project and are not on the construction site.",
  tags=["regulatory", "src:29CFR5.2", "coverage"], confidence=1)

# NOTE: the pre-2023 "within seven days of the regular pay date" window was REMOVED in the
# 2023 DBRA rule revision — verify current text; do not assert the 7-day window at confidence 1.
remember(subject="rule:weekly-submission", key="requirement",
  value="On covered projects, the contractor and each subcontractor must submit a certified payroll weekly for every week in which any covered work is performed.",
  tags=["regulatory", "src:29CFR5.5(a)(3)", "certified-payroll"], confidence=1)
```

- [ ] **Step 3: Write the WH-347 field-spec claims (after verifying against form instructions)**

**One fact per `(subject, key)`** — each WH-347 part is a DISTINCT subject, or combine/resolve will silently deprecate all but the last write (see Conventions).

```
remember(subject="form:wh-347:column-6", key="field-spec",
  value="Column 6 (Rate of Pay) shows the straight-time hourly rate actually paid plus any cash paid in lieu of fringe benefits; the cash-in-lieu portion may be shown separately from the basic rate, e.g. '$12.25/.40'. The overtime rate plus cash-in-lieu goes in the overtime box.",
  tags=["regulatory", "src:DOL-WH347-instructions", "certified-payroll", "fringe"], confidence=1)

remember(subject="form:wh-347:column-7", key="field-spec",
  value="Column 7 (Gross Amount Earned) reports gross pay for the week; if the worker also worked on other projects, enter the amount earned on the federal/federally-assisted project first, then total gross across all projects, e.g. '$163.00/$420.00'.",
  tags=["regulatory", "src:DOL-WH347-instructions", "certified-payroll"], confidence=1)

remember(subject="form:wh-347:statement-of-compliance", key="field-spec",
  value="On the Statement of Compliance (page 2), check box 4(a) when all fringe benefits are paid into approved plans/funds/programs (then show basic cash + overtime rates on the payroll face), or 4(b) when fringe is paid as cash in lieu; any shortfall to a plan must be paid to the worker as cash in lieu of fringe.",
  tags=["regulatory", "src:DOL-WH347-instructions", "certified-payroll", "fringe"], confidence=1)
```

- [ ] **Step 4: Write the fringe / overtime mechanics claims (after verifying)**

```
remember(subject="rule:fringe-credit", key="requirement",
  value="An employer may take credit toward the prevailing-wage obligation for contributions to bona-fide fringe-benefit plans; the credit is the hourly cost of the benefit, not the benefit's face value.",
  tags=["regulatory", "src:29CFR5.5", "fringe"], confidence=1)

remember(subject="rule:overtime-base", key="requirement",
  value="Overtime under CWHSSA is computed on the basic hourly rate (cash wage), not the total prevailing wage including fringe; fringe is generally not part of the regular rate for OT.",
  tags=["regulatory", "src:29CFR5.32", "overtime", "fringe"], confidence=1)

remember(subject="rule:fringe-annualization", key="requirement",
  value="For benefit plans not paid in cash, the hourly credit must be annualized over all hours worked (Davis-Bacon and non-Davis-Bacon) to prevent over-crediting from public-works hours.",
  tags=["regulatory", "src:29CFR5.25", "fringe"], confidence=1)
```

- [ ] **Step 5: Write the apprentice / debarment claims (after verifying)**

```
remember(subject="rule:apprentice-rate", key="requirement",
  value="Apprentices may be paid less than the journey-worker prevailing rate only if registered in a DOL/state-approved apprenticeship program; otherwise they must be paid the full classification rate.",
  tags=["regulatory", "src:29CFR5.5", "apprenticeship"], confidence=1)

remember(subject="rule:apprentice-ratio", key="threshold",
  value="The allowable ratio of apprentices to journey-workers on the job site is governed by the registered apprenticeship program's standards; exceeding it requires paying the full rate to the excess apprentices.",
  tags=["regulatory", "src:29CFR5.5", "apprenticeship"], confidence=1)

remember(subject="rule:debarment", key="requirement",
  value="Contractors found in willful or aggravated violation of Davis-Bacon may be debarred from federal contracts for up to three years.",
  tags=["regulatory", "src:29CFR5.12", "coverage"], confidence=1)
```

- [ ] **Step 6: Verify the regulatory layer recalls and shows provenance**

Call: `mcp__mneme__recall` with `{ about: "how should fringe be tracked separately on certified payroll?", corpus: "adv-payroll", relevanceFloor: 0.3 }`
Expected: the WH-347 fringe field-spec and `rule:fringe-credit` surface with `confidence: 1` and a `src:` tag visible. This is the original baseline question (Task 1, Step 2) now answered.

---

### Task 4: Operational know-how layer (~8 pitfall claims)

**Files:** none (writes to `adv-payroll`). Common fields: `corpus: "adv-payroll"`, tags include `jur:federal` + `auth:DOL-WHD` + layer tag `operational` (no `scope` — see Conventions), `confidence` 0.8.

- [ ] **Step 1: Write the pitfalls**

```
remember(subject="pitfall:fringe-cash-vs-plan", key="pitfall",
  value="Contractors commonly misreport bona-fide fringe contributions as cash wages, inflating gross pay and miscalculating the overtime base.",
  tags=["operational", "fringe"], confidence=0.8)

remember(subject="pitfall:wrong-classification", key="pitfall",
  value="Misclassifying a worker into a lower-paid labor classification than the work performed is a frequent violation; the actual duties, not the title, govern the required rate.",
  tags=["operational", "coverage"], confidence=0.8)

remember(subject="pitfall:missing-weekly-payroll", key="pitfall",
  value="Skipping the certified payroll for a week with minimal covered work; a report is required for every week any covered work occurs, even partial.",
  tags=["operational", "certified-payroll"], confidence=0.8)

remember(subject="pitfall:unregistered-apprentice", key="pitfall",
  value="Paying apprentice rates to workers not enrolled in an approved program — a common cause of back-wage liability.",
  tags=["operational", "apprenticeship"], confidence=0.8)

remember(subject="pitfall:fringe-not-annualized", key="pitfall",
  value="Taking full hourly fringe credit on public-works hours when the benefit's annual cost is spread across all hours worked, over-crediting the Davis-Bacon obligation.",
  tags=["operational", "fringe"], confidence=0.8)

remember(subject="pitfall:overtime-on-fringe", key="pitfall",
  value="Incorrectly including the fringe portion in the regular rate when computing overtime, overpaying OT and complicating reconciliation.",
  tags=["operational", "overtime"], confidence=0.8)

remember(subject="pitfall:stale-wage-determination", key="pitfall",
  value="Using a wage determination that was superseded before contract award; the determination locked into the contract governs, and using an outdated schedule underpays workers.",
  tags=["operational", "coverage"], confidence=0.8)

remember(subject="pitfall:site-of-work-scope", key="pitfall",
  value="Disputes over whether off-site fabrication or a dedicated batch plant counts as 'site of the work' and is therefore covered; misjudging scope leads to under-reporting.",
  tags=["operational", "coverage"], confidence=0.8)
```

- [ ] **Step 2: Verify the operational layer recalls**

Call: `mcp__mneme__recall` with `{ about: "what mistakes do contractors make with fringe benefits?", corpus: "adv-payroll", relevanceFloor: 0.3 }`
Expected: `pitfall:fringe-cash-vs-plan` and `pitfall:fringe-not-annualized` surface.

---

### Task 5: Verification gate

**Files:** none.

- [ ] **Step 1: Key-proliferation audit**

Call: `mcp__mneme__key_census` with `{ corpus: "adv-payroll" }`
Expected: the distinct keys are a subset of the 8 controlled keys (`definition`, `requirement`, `coverage`, `field-spec`, `threshold`, `pitfall`, `relates-to`, `rationale`). If any unexpected key appears, fix the offending claim (rewrite with a controlled key).

- [ ] **Step 2: Representative design-question recalls**

Run these `mcp__mneme__recall` queries against `corpus: "adv-payroll"` and confirm each returns a relevant, correct top match:
1. `"what counts as the site of work for davis-bacon coverage?"` → expect `rule:dbra-coverage` / `pitfall:site-of-work-scope`.
2. `"how is overtime calculated on prevailing wage jobs?"` → expect `rule:overtime-base`.
3. `"when must certified payroll be submitted?"` → expect `rule:weekly-submission`.
4. `"can I pay apprentices a lower rate?"` → expect `rule:apprentice-rate` (confidence 1).
5. `"what is a wage determination?"` → expect `term:wage-determination`.

- [ ] **Step 3: Confirm provenance is legible**

Spot-check 3 hot-fact recalls and confirm each shows `confidence: 1` and a `src:` tag. Confirm soft claims show `confidence` 0.8–0.9 and no `src:` tag.

- [ ] **Step 4: Commit the plan completion note**

Record (in the dogfood log / commit message of any doc update) that the `adv-payroll` slice is seeded: ~30 claims, hot facts verified, census clean.

---

## Self-Review notes

- **Spec coverage:** vocabulary layer → Task 2; regulatory facts → Task 3; operational know-how → Task 4; schema conventions → enforced in every task's common-fields + Task 5 census; hybrid sourcing/verification → Task 3 Steps 1 + per-claim `src:` tags; verification gate → Task 5. All spec sections mapped.
- **Controlled keys used:** `definition`, `requirement`, `coverage`, `field-spec`, `threshold`, `pitfall`, `relates-to` — all within the 8. (`rationale` unused in this slice; that is fine — the vocabulary is a ceiling, not a quota.)
- **Hot facts flagged for verification:** all `confidence: 1` claims in Task 3 carry a draft value + `src:` tag and are gated behind Task 3 Step 1's source fetch.
