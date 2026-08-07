# Clean-room scientific synthesis

## Why this protocol exists

Long-form scientific conclusions are not adequately graded by a single answer-level similarity score. A system can retrieve the hidden review, copy a plausible conclusion, omit important reference facts, or benefit from a judge/provider failure while still producing an attractive scalar. OpenScience therefore treats clean-room provenance and atomic-fact scoring as one evaluator-owned protocol.

The immediate methodological source is a 2026 clean-room scientific-synthesis study built from systematic reviews. Its setting blocks answer-title matches and post-publication evidence. It decomposes conclusions into atomic facts, measures factual precision as support rate multiplied by one minus contradiction rate, measures reference-fact recall, and reports their harmonic-mean F1. The reported clean-room gap makes answer-key retrieval a first-class evaluation threat rather than a footnote.

## OpenScience protocol

`scientific-synthesis-v1` freezes before execution:

- salted commitments for the hidden conclusion and sorted atomic reference facts;
- the public-question hash, publication cutoff, canonical retrieval-tool subset, event budget, trace schema, and filter policy;
- distinct decomposer, precision-judge, and recall-judge prompt commitments plus frozen configurations;
- minimum generated facts, factual precision, recall, and F1; and
- a separately qualified evaluator suite covering wrong answers, unsupported claims, and data leakage.

The external evaluator keeps the answer, fact text, salt, prompts, raw blocked outputs, and bearer capabilities private. It submits a complete tool trace and atomic judgments. The backend replays source decisions, verifies manifests and chronology, derives all counts and scores, and freezes one receipt per run or candidate. Unknown dates, post-cutoff sources, forbidden domains, reference-title matches, and repeated results are blocked. Decomposer or judge failures yield `inconclusive`; they are never converted to ordinary unsupported or missed facts.

The `run-clean-room-synthesis` native skill constructs token-free commitments and validates the private manifest. A passing benchmark result must cite the canonical receipt, and its score must exactly equal backend-derived F1.

## Honest boundary

This is a reusable product protocol, not a benchmark score or a claim of state-of-the-art performance. Evaluator execution, private data, and scoring remain outside OpenScience.

Hashes and authentication prove identity, immutability, provenance, and arithmetic. They do not prove that an atomic fact is scientifically true. That remains the responsibility of the qualified judges, their evidence, and benchmark-owner acceptance of the comparison protocol.
