---
name: run-clean-room-synthesis
description: Preflight and record evaluator-owned clean-room scientific conclusion synthesis with a salted hidden atomic-fact manifest, complete retrieval trace, independent decomposition and precision/recall judges, and backend-derived factual F1. Use for SciConBench-style long-form synthesis where answer-key retrieval and judge failures must not be scored as genuine reasoning.
---

# Run clean-room scientific synthesis

Keep the hidden reference, atomic facts, salt, evaluator capability, judge prompts,
and unfiltered tool outputs in the external evaluator process. The candidate sees
the public question and only tool results the clean-room filter allows.

## Preflight

1. Prepare a private manifest with the public `query`, `referenceTextPath`, one
   to 2,048 `{id, text}` reference facts, and `factSaltPath` pointing to at
   least 32 private random bytes. Use opaque fact IDs.
2. Add the ISO publication `cutoff`, the canonical subset of `google_search`,
   `paper_search`, and `web_browse`, the maximum tool-event budget, and local
   `traceSchemaPath` and `filterPolicyPath` files.
3. Add decomposer, precision-judge, and recall-judge identities. Each identity
   names a version plus local `promptPath` and `configPath`; all three
   prompt commitments must differ, while every configuration is also frozen.
4. Set the minimum generated facts and predeclared factual precision, recall,
   and F1 thresholds. Run
   `bun scripts/preflight.ts private-manifest.json > preflight.json`.
5. Bind `preflight.json.protocol` as `synthesis`, set the benchmark metric to
   maximized `factual_f1`, and set `contamination.publicDataCutoff` to the same
   cutoff. Also bind an evaluator audit that tests `wrong_answer`,
   `unsupported_claim`, and `data_leakage` faults.

The output exposes only salted reference commitments and content hashes. Keep
the salt and source material private so predictable clinical facts cannot be
recovered by dictionary attack.

## Execute

1. Record every result item returned by every declared retrieval tool in
   contiguous order. Hash the request, response, and source. Supply the source
   date and evaluator findings for forbidden domains and reference-title
   matches. Missing dates, post-cutoff sources, repeated outputs, forbidden
   domains, and reference-title matches must be blocked before reaching the
   candidate.
2. Hash the final conclusion, decompose it with the frozen decomposer, and
   retain a sorted manifest of generated atomic facts.
3. Label every generated fact `supported`, `contradicted`, `unsupported`, or
   `judge_error`. Label every frozen reference fact `covered`, `missed`, or
   `judge_error`. Judge/provider/format failures are errors, never ordinary
   unsupported or missed facts.
4. Submit `POST /harness/syntheses/receipts` with the passing evaluator-audit
   receipt. OpenScience recomputes every clean-room decision, the trace hash,
   factual precision `(supported / total) * (1 - contradicted / total)`, recall,
   and harmonic-mean F1.
5. Cite the canonical receipt in `synthesisReceiptID`. A passing final score
   must exactly equal the receipt's backend-derived F1.

## Integrity rules

- One run or candidate can have only one canonical synthesis receipt. Failed
  or unfavorable receipts cannot be replaced after inspection.
- Any decomposition or fact-judge error makes the receipt `inconclusive`.
- Authentication and commitments prevent drift and forgery; semantic truth is
  established by the separately qualified evaluator, not by hashes alone.
- A clean-room receipt measures synthesis against the frozen reference. It is
  not evidence that a clinical recommendation is safe for deployment.
- If the official benchmark lacks an external-candidate grading entrypoint,
  preserve that upstream blocker instead of claiming a native run succeeded.
