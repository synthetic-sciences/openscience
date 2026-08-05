---
name: run-sealed-confirmation
description: Run the evaluator-owned sealed-confirmation-v1 workflow for an OpenScience optimize session. Use when a terminal adaptive search must confirm exactly one backend-selected winner on a distinct held-out or release claim split, validate a claim-result envelope, or submit/read a capability-protected confirmation receipt without leaking claim feedback into optimization.
---

# Run Sealed Confirmation

Treat optimization scores as provisional. Confirm only the immutable terminal selection returned by the backend, exactly once, through the claim evaluator capability.

## Workflow

1. Require a bound `sealed-confirmation-v1` contract. Stop if the optimization and claim splits or manifests are not distinct.
2. Request `POST /harness/confirmations/selection` from the evaluator host. Keep `confirmationToken` in the secret-owning transport; never write it to a file, log, prompt, notebook, or command line.
3. Stop if search is not terminal. Accept only the returned candidate artifact; never submit a candidate ID or replace the artifact.
4. Run the frozen claim validator once against the committed claim manifest and environment. Do not return partial metrics, per-example feedback, hidden inputs, or repair hints to the optimization process.
5. Create a token-free result JSON and validate it:

```bash
python3 scripts/preflight.py \
  --protocol confirmation-protocol.json \
  --selection confirmation-selection.json \
  --result claim-result.json \
  --out confirmation-payload.json
```

6. Let the secret-owning transport add `confirmationToken` in memory and send the payload to `POST /harness/confirmations/receipts`.
7. Preserve the returned receipt ID. Do not rerun the claim split, resume search, capture claim hindsight, or generate a learned skill from the result.

Read [references/protocol.md](references/protocol.md) before constructing API envelopes or diagnosing a rejected submission.

## Result rules

- Use `outcome: completed` only with a finite score and the exact bound metric equal to that score.
- Use `outcome: failed` or `inconclusive` without a score or bound metric.
- Echo the selection's candidate artifact hash and the frozen claim manifest, validator, and environment hashes.
- Include at least one blocking check and evidence. The backend derives pass/fail from checks, direction, and target.
- Treat an identical retry as transport recovery only. A changed result after the first canonical receipt is forbidden.

## Stop conditions

- Stop before claim evaluation if selection is unavailable, nonterminal, malformed, or contradicts the protocol.
- Stop on any commitment drift, candidate substitution, timestamp before selection, token exposure, or request for claim feedback during search.
- If the first receipt is failed or inconclusive, record it as final evidence. Do not open the holdout for repair.
