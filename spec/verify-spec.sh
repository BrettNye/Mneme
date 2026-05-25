#!/usr/bin/env bash
# spec/verify-spec.sh — integrity gate for the consolidated Mneme spec.
set -uo pipefail
DOC="${1:-mneme-spec-v0.2-consolidated.md}"
fail=0
check(){ if [ "$1" -eq 0 ]; then printf 'PASS %s\n' "$2"; else printf 'FAIL %s\n' "$2"; fail=1; fi; }

# Rule 1 — deprecated-rule guard
! { grep -nE 'rule_max_confidence' "$DOC" | grep -vi 'deprecated' | grep -q .; }; check $? no-deprecated-rule
! grep -Fq 'sum the underlying Beta parameters' "$DOC"; check $? no-naive-pooling
# Rule 1b — wrong SL bridge form must be absent
! grep -Fq 'α / (α + β + W)' "$DOC"; check $? no-wrong-sl-bridge

# Rule 2 — worked-example numeric anchors
grep -Fq 'belief = (α−a·W)/(α+β)' "$DOC"; check $? sl-bridge-correct
grep -Fq 'uncertainty = W/(α+β)' "$DOC"; check $? sl-uncertainty
grep -Fq 'Beta(5,3)' "$DOC"; check $? worked-pooling
grep -Fq 'α_pooled = α₁ + α₂ − a·W' "$DOC"; check $? pooled-formula
grep -Fq 'Dirichlet(3, 1.2, 0.8)' "$DOC"; check $? extend-to-frame
{ grep -Eq '0\.55' "$DOC" && grep -Eq '0\.21' "$DOC"; }; check $? wilson-numbers
grep -Fq '0.793' "$DOC"; check $? migration-shift

# Rule 3 — convention pinned
grep -Fq 'α = r + a·W' "$DOC"; check $? convention-pinned

# Rule 4 — tier tags present
{ grep -Fq '[C]' "$DOC" && grep -Fq '[P]' "$DOC" && grep -Fq '[Prof]' "$DOC"; }; check $? tier-tags

# Rule 5 — de-aliasing / new capability anchors
grep -Fq 'bimodal_approximation_warning' "$DOC"; check $? gaussian-bimodal
grep -Fq 'agreementRatio = largest_group_size / total_claims' "$DOC"; check $? cluster-ratio
grep -Fq 'integrity_unknown' "$DOC"; check $? replay-status
grep -Fq 'embeddingModelId' "$DOC"; check $? embedding-scope-field
grep -Fq 'valuePredicateSupport' "$DOC"; check $? value-predicate-matrix

# Rule 6 — no-orphan: each TOC section/appendix has a heading
for s in '## 0.' '## 1.' '## 2.' '## 3.' '## 4.' '## 5.' '## 6.' '## 7.' '## 8.' '## 9.' '## 10.' '## 11.' '## 12.' \
         '## Appendix A' '## Appendix B' '## Appendix C' '## Appendix D' '## Appendix E' '## Appendix F' '## Appendix G' '## Appendix H'; do
  grep -Fq "$s" "$DOC"; check $? "section-present:${s}"
done

exit $fail
