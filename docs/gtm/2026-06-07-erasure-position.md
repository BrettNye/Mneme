# Erasure in an append-only memory: Mneme's position

**Draft for outreach · 2026-06-07 · not legal advice**

---

## The objection, stated plainly

Mneme's value rests on never destroying epistemic state: corrections supersede, they don't
overwrite. A compliance reader's immediate counter is GDPR Article 17 / CCPA deletion rights:
*"If you can't delete, you can't be deployed."* This document is our designed answer. The short
version: **append-only is a property of the epistemic record, not a refusal to erase — erasure
is designed in at the boundaries where the law actually operates.**

## Three principles

1. **The audit trail and the data subject's content are different objects.** Regulators who
   demand records (17a-4, AI Act Art. 12) and regulators who demand erasure (GDPR Art. 17) are
   not in contradiction — retention obligations are a recognized lawful basis for retaining
   *processing* records (Art. 17(3)(b)) even as *content* is erased. The architecture must be
   able to erase one without corrupting the other.
2. **Erasure should be as auditable as everything else.** "We deleted it" is itself a claim a
   review will test. Erasure events leave tombstone metadata — *that* something was removed,
   when, and under what request — without retaining *what* was removed.
3. **Tenancy is the natural erasure boundary.** Mneme's corpus model is corpus-per-tenant by
   design; the common case (a customer leaves; a user's whole memory must go) maps to a unit
   the system already isolates.

## The mechanism ladder

| Level | Scope | Mechanism | Status |
|---|---|---|---|
| 1 | **Tenant / whole-corpus erasure** | The corpus is a discrete store; destruction of the corpus (file/DB deletion) is complete, verifiable erasure of content, ledger, and derived state together | **Available today** — corpus = tenant is the ratified deployment model |
| 2 | **Per-subject erasure within a corpus** | **Crypto-shredding**: claim *content* (values, evidence) encrypted with per-subject keys held outside the ledger; erasure = key destruction. The ledger's *structure* (that claims existed, superseded, were read) survives for audit; the content becomes irrecoverable | **Designed; not yet implemented** — the claims schema's subject field and provenance separation were shaped for this |
| 3 | **Derived-data hygiene** | Derived claims carry full input provenance, so the *blast radius* of an erasure is computable: every belief derived from erased inputs is identifiable and can be re-derived without them or shredded with them. Destructive stores cannot even enumerate what a deletion should propagate to | Provenance is implemented today; propagation tooling follows Level 2 |
| 4 | **Erasure tombstones** | An erasure writes a structural event (subject, scope, request reference, timestamp — no content) so the record of compliance is itself replayable | Designed alongside Level 2 |

## Why this is *stronger* than DELETE, not weaker

A conventional memory product's DELETE makes two unverifiable promises: that the row is gone
everywhere (caches, embeddings, derived summaries — usually it isn't), and that nothing else
silently depended on it. Mneme inverts both: provenance makes dependency enumeration a query
(Level 3), and key destruction makes content irrecoverability a cryptographic fact rather than
an operational hope. The append-only ledger doesn't resist erasure — it makes erasure
*accountable*.

## Honest edges, stated before you ask

- **Level 2 is a design position, not shipped code.** We say so in the same breath as the
  pitch; for a design-partner engagement it is a scoped, near-term work item, and Level 1
  covers the tenant-departure case today.
- **Embeddings and logs:** derived vectors and recall-log lines that quote content fall inside
  the same shredding boundary by design; this is part of the Level 2 scope, not an afterthought.
- **Residual metadata:** tombstones intentionally retain that *a* record existed for *a*
  subject. Where even that is unacceptable, Level 1 (corpus destruction) is the answer, which
  is one reason corpus-per-tenant is the default posture.

## One paragraph for your DPO

Mneme retains an append-only record of an agent's belief history for auditability; data-subject
content within that record is erasable by per-subject cryptographic shredding (with key
destruction as the erasure act), whole tenants are erasable by corpus destruction, derived data
is enumerable via provenance for propagation, and every erasure leaves a content-free,
auditable tombstone. Retention of processing structure under legal obligation and erasure of
personal content are handled as separate objects, per Art. 17(3)(b).

---

*Companion document: "Agent memory that survives a compliance review" (controls mapping).*
