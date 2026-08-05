# Verifier-routed-v1 protocol

The backend runs bounded panels and derives routes with fixed precedence:

1. Any `reject/critical` verdict causes a clean generator restart.
2. Otherwise, any `abstain/unknown` verdict causes evidence investigation.
3. Otherwise, any `reject/minor` verdict causes targeted revision.
4. Otherwise, unanimous `support/none` verdicts at or above the contract confidence threshold accept the candidate.
5. Any remaining low-confidence panel causes evidence investigation.

The attempt ceiling is `orchestration.maxRounds`. Every possible candidate/action and verifier panel is budgeted before execution. Reaching the ceiling stops without another action. Only the terminal panel contributes to final consensus; earlier rejected or inconclusive panels remain provenance.

## Context boundaries

| Unit | Direct context | Forbidden context |
|---|---|---|
| Initial candidate | None | Prior attempts |
| Targeted revision | Candidate and the rejecting panel | Hidden reasoning and unrelated ancestors |
| Clean restart | Rejecting panel only | Rejected candidate artifact or summary |
| Evidence investigation | Candidate and inconclusive panel | Candidate edits |
| Verification | Current candidate and optional new investigation | Other verifier verdicts and stale panels |

The DAG may retain transitive causal provenance even when a clean restart omits the rejected candidate from the worker's direct context.

## Result envelope

Non-verifier:

```json
{
  "summary": "what was produced or observed",
  "artifactRefs": ["artifact://..."],
  "evidenceRefs": ["evidence://..."],
  "usage": {"steps": 1, "tokens": 1000, "costUSD": 0.01, "wallTimeMs": 1000}
}
```

Verifier:

```json
{
  "summary": "independent review",
  "artifactRefs": [],
  "evidenceRefs": ["evidence://review.json"],
  "usage": {"steps": 1, "tokens": 1000},
  "verdict": {
    "decision": "reject",
    "severity": "minor",
    "confidence": 0.84,
    "checks": [
      {"id": "residual-check", "status": "failed", "evidenceRefs": ["evidence://residual.json"]}
    ]
  }
}
```
