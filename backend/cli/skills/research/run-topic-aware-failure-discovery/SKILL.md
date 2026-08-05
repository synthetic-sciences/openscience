---
name: run-topic-aware-failure-discovery
description: Preflight and execute an evaluator-owned topic-aware adversarial failure-discovery stream with frozen topic, generator, validator, embedding, audit-pool, and budget commitments. Use when generated stress cases should discover diverse target-model failures without entering the official benchmark score or population estimate.
---

# Run topic-aware failure discovery

Keep this workflow in the external evaluator process. Never expose topic definitions,
anchor contents, generated cases, expected answers, evaluator tokens, or target outputs to
the candidate agent.

## Preflight

1. Finish and seal the bound active audit. Use only its authenticated observed
   failures as anchors.
2. Prepare a private JSON manifest containing:
   - `sourcePoolSHA256` from the audit receipt;
   - two to 64 topics as `{id, definition}`, using opaque IDs containing only
     letters, digits, `.`, `_`, `:`, or `-`, plus `topicSaltPath` pointing to a
     private file with at least 32 random bytes;
   - topic-model, generator, correctness-validator, topic-validator,
     novelty-validator, and embedding identities with local `promptPath` and
     `configPath` files; the generator and three validators must use distinct
     prompt/config commitment pairs, not merely different display names;
   - embedding dimensions, attempt budget, anchors per attempt, the exact audit
     failure threshold, and optional failure target.
3. Run `bun scripts/preflight.ts private-manifest.json > preflight.json`.
4. Inspect `preflight.json`. Topic commitments are salted, so keep the salt with
   the private manifest for later opening or audit. The output contains opaque
   topic IDs/commitments and frozen identity metadata/file hashes, but no topic
   definitions or prompt/config bytes. Bind `preflight.json.protocol` as
   `failureDiscovery` in the harness task. Keep the source manifest and
   referenced files outside the candidate environment.

## Execute

1. Initialize `POST /harness/failure-streams` with the exact subject artifact
   and terminal audit receipt.
2. Request `POST /harness/failure-streams/:streamID/selection`. Use exactly the
   returned topic and anchors; never choose either client-side.
3. Generate one case in the returned topic while transposing the anchors'
   failure pattern. Hash the canonical hidden case and generator output.
4. Run the three frozen validators independently:
   - `correctness`: the generated task and answer are valid;
   - `topic`: the case belongs to the selected topic;
   - `novelty`: it is not a semantic restatement of prior cases.
5. Submit the attempt. A generation failure uses `generation.status=failed`, no
   validators, and no target outcome. A generated case supplies all validators;
   submit a target outcome only when all three pass. Supply an L2-normalized
   embedding from the frozen embedding identity.
6. Repeat until the server reports `completed`, then seal the receipt. Cite its
   ID in `failureDiscoveryReceiptID` only as robustness provenance.

## Integrity rules

- Every attempt consumes budget. Invalid, inconclusive, failed, or duplicate
  cases earn zero reward.
- OpenScience forces every topic once, then recomputes UCB1 from the immutable
  attempt journal. Treat a returned selection as a server lease, not advice.
- Never put generated cases into the active-audit pool, a benchmark evaluation
  metric, candidate fitness, retrospective score memory, or a confirmation
  split.
- The receipt proves protocol execution and records failure yield/diversity. It
  does not prove state of the art or change the official score.
- If the generator and validator disagree, retain the failed/inconclusive
  attempt. Do not repair its label after observing the target result.
