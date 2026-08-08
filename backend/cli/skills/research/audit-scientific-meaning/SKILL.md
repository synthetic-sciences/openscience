---
name: audit-scientific-meaning
description: Prepare and preflight an independent OpenScience semantic-audit panel for one run or candidate. Use when a bound semantic-audit-v1 contract requires reviewers to distinguish meaningful scientific resolution from a technically correct but misinterpreted, vacuous, known, rediscovered, or ambiguous result before final evaluation.
---

# Audit scientific meaning

Use this skill only from the independent semantic-review process. It creates evidence-bearing reviewer records for `POST /harness/semantics/receipts`; it never assigns the final receipt status or benchmark score.

## Workflow

1. Read the immutable harness contract and locate `semanticAudit`.
2. Verify `semanticAudit.scope.objectiveSHA256` against the exact contract objective.
3. Give each reviewer the frozen objective, criteria, forbidden shortcuts, literature cutoff, corpus commitment, novelty floor, and candidate artifact. Keep reviewer sessions and actors distinct.
4. Each reviewer independently checks:
   - factual or mathematical correctness;
   - alignment with the intended problem rather than a weaker interpretation;
   - whether the result is substantive rather than vacuous;
   - every frozen criterion and forbidden shortcut;
   - novelty only against literature within the frozen cutoff and corpus scope.
5. Require observable evidence for every criterion and shortcut judgment. A citation or URI is a pointer, not proof that its content supports the judgment.
6. Preserve `inconclusive` and `ambiguous` when evidence cannot decide. Do not lower a novelty floor or reinterpret the objective after seeing the candidate.
7. Build a token-free JSON submission containing `sessionID`, `subject`, and `reviews`.
8. Preflight it:

```bash
python scripts/validate_submission.py contract.json semantic-submission.json
```

9. Inject `reviewerToken` only in memory immediately before the authenticated request. Never write it to the submission or evidence bundle.
10. Store the returned receipt even when it is `technical_only`, `ambiguous`, or `failed`; negative semantic evidence must remain durable.

## Outcome semantics

- `meaningful`: every review is correct, aligned, substantive, complete, sufficiently confident, and at or above the novelty floor.
- `technical_only`: the work may be technically valid but misinterprets the problem, is vacuous, uses a forbidden shortcut, fails a frozen criterion, or falls below the novelty floor.
- `ambiguous`: material correctness, alignment, criteria, or reviewer confidence remains unresolved.
- `failed`: at least one reviewer finds the result incorrect.

The backend recomputes these outcomes and binds the receipt to the exact contract and subject. Reviewers must never submit a desired aggregate status.

## Guardrails

- Do not show one reviewer another review before every record is frozen.
- Do not infer novelty from absence in a casual search; cite the frozen corpus search evidence.
- Do not treat independent rediscovery as novel when the contract requires minor, publication-grade, or major novelty.
- Do not accept a mathematically or technically valid loophole that an expert would recognize as outside the intended question.
- Do not replace required physical, statistical, biological, chemical, or empirical validation with semantic review.
- Read [references/protocol.md](references/protocol.md) for the exact decision precedence and novelty scale.
