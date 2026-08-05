# Clean-room scientific synthesis

## Why this protocol exists

Long-form scientific conclusions are not adequately graded by a single answer-level similarity score. A system can retrieve the hidden review, copy a plausible conclusion, omit important reference facts, or benefit from a judge/provider failure while still producing an attractive scalar. OpenScience therefore treats clean-room provenance and atomic-fact scoring as one evaluator-owned protocol.

The immediate source is [SciConBench](https://arxiv.org/abs/2606.11337), released June 2026 with 9,107 live questions derived from Cochrane systematic reviews. Its clean-room setting blocks Cochrane/reference-title matches and post-publication evidence. It decomposes conclusions into atomic facts, measures factual precision as support rate multiplied by one minus contradiction rate, measures reference-fact recall, and reports their harmonic-mean F1. The paper reports a large gap between clean-room and unconstrained evaluation, making answer-key retrieval a first-class benchmark threat rather than a footnote.

The official [SciConBench repository](https://github.com/hayoungjungg/SciConBench) was inspected at commit `30b0c6d3ccfac844651db137dbd48e053b424e51`, including its harness, Cochrane filter, atomic-fact generation, precision and recall analyzers, and precision equations. The separately published dataset is [hayoungjung/SciConBench](https://huggingface.co/datasets/hayoungjung/SciConBench).

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

This is a protocol implementation, not a SciConBench score and not a claim of SOTA. At the inspected revision, the official `evaluate.py` owns model/provider execution and demonstrates internal configurations, but it does not expose an unchanged entrypoint that accepts an external conclusion and emits one stable machine-readable official score artifact. The catalog therefore marks SciConBench `blocked_upstream`. OpenScience will not invent a source-verified recipe around a modified grader and call it official.

Hashes and authentication prove identity, immutability, provenance, and arithmetic. They do not prove that an atomic fact is scientifically true. That remains the responsibility of the qualified judges, their evidence, and benchmark-owner acceptance of the comparison protocol.
