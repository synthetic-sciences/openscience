# Sealed confirmation protocol

## Trust boundary

The optimization evaluator may be queried repeatedly and may return detailed feedback. Its results remain provisional. The claim evaluator has a distinct identity and capability, receives one terminal backend selection, and returns no search feedback.

The backend enforces:

- optimization split `development` or `validation`;
- claim split `held_out` or `release`;
- distinct committed manifests;
- a numeric metric, direction, and target shared by optimization and claim evaluation;
- one verified candidate selected from a terminal search state;
- one canonical content-addressed receipt per session;
- report quality derived only from the claim receipt for confirmation-enabled contracts.

## Protected APIs

`POST /harness/confirmations/selection`

```json
{
  "sessionID": "session-id",
  "confirmationToken": "in-memory secret"
}
```

The response binds `contractSHA256`, `protocolSHA256`, terminal search revision and stop reason, candidate ID and artifact, durable optimization-evaluation and search-result hashes, and selection time. Do not copy the candidate ID into a receipt submission; the server derives it.

`POST /harness/confirmations/receipts`

The token-free payload produced by `scripts/preflight.py` needs `confirmationToken` added only inside the authenticated transport. A completed submission contains the score and exact bound metric. Failed or inconclusive submissions contain neither.

`POST /harness/confirmations/receipts/:receiptID`

Use the same claim evaluator capability to read and validate the canonical receipt. Optimization evaluator credentials cannot access it.

## Information firewall

Never place claim inputs, per-example outcomes, notes, or feedback in an optimization evaluation, search observation, retrospective-memory record, coalition prompt, or learned-skill proposal. The terminal report may expose only the derived aggregate status, score, target result, evaluator identity, and receipt ID.

Exact retries recover transport failures. Any changed output, metric, timestamp, evidence, or check after the first receipt is a second holdout attempt and must be rejected.
