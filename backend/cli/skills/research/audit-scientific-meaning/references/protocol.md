# Semantic-audit-v1 protocol

The contract freezes the exact objective hash, required criteria, forbidden shortcuts, literature cutoff, corpus commitment, novelty floor, minimum independent reviewer count, and minimum confidence before candidate execution.

## Backend precedence

1. Any `correctness=failed` review derives `failed`.
2. Otherwise, any inconclusive correctness or criterion, ambiguous alignment, or confidence below the contract threshold derives `ambiguous`.
3. Otherwise, any misinterpretation, vacuity, failed criterion, observed shortcut, or novelty below the frozen floor derives `technical_only`.
4. Only a panel with none of those conditions derives `meaningful`.

The order matters: a wrong answer is not merely a weak novelty result, and missing evidence is not permission to call a loophole meaningful.

## Novelty scale

| Level | Meaning |
|---|---|
| `not_required` | The contract makes no novelty claim. |
| `known` | The same substantive result is already in the frozen literature scope. |
| `rediscovery` | The candidate independently reaches an existing substantive result. |
| `minor` | A new result or method with limited research novelty. |
| `publication` | A result plausibly meeting ordinary peer-reviewed research novelty. |
| `major` | A field-level advance requiring exceptional evidence. |

When the floor is above `not_required`, every reviewer must provide literature-search evidence. A `not_required` review can pass only when the frozen floor is also `not_required`; it is not an alias for `known`. The backend compares ordered levels; review prose cannot override the frozen floor.

## Why this exists

[Aletheia](https://arxiv.org/abs/2602.10177) reported that 63 of 200 audited Erdős responses were technically correct, but only 13 addressed the intended problem meaningfully; many valid answers exploited trivial interpretations. The 2026 [Co-Scientist Nature paper](https://www.nature.com/articles/s41586-026-10644-y) instead freezes research goals with attributes and constraints, evaluates novelty relative to publication, uses independent experts, and validates consequential claims experimentally. A 2026 [specification-gaming study](https://arxiv.org/abs/2605.02269) found that prompt-time mitigations reduce but do not eliminate exploitation.

Semantic review therefore remains separate from ordinary correctness, domain validation, and benchmark scoring.
