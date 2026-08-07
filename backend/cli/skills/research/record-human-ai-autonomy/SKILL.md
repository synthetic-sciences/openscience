---
name: record-human-ai-autonomy
description: Preflight and record a complete evaluator-owned human-AI interaction trace, bind it to an exact benchmark run or candidate artifact, and obtain a backend-derived essentially-autonomous, collaborative, or primarily-human receipt. Use when reporting autonomous scientific benchmark results, publishing Human-AI Interaction cards, or preventing hidden human hints from being mislabeled as agent-only performance.
---

# Record human-AI autonomy

Capture the interaction stream outside the candidate sandbox. Keep raw prompts,
outputs, and evaluator capabilities private; expose only commitments and retained
evidence references to OpenScience.

Read [references/protocol.md](references/protocol.md) before classifying events.

## Freeze the protocol

1. Prepare a manifest with `claimedLevel`, recorder name/version and local
   executable path, local trace-schema and classification-policy paths,
   `maxEvents`, and the disclosure policy.
2. Run `bun scripts/preflight.ts protocol protocol-manifest.json`.
3. Bind the emitted `protocol` as `autonomy` before the agent starts. Use
   `intervention: human_reprompted` for collaborative or primarily-human claims.

## Capture and submit

1. Record the frozen benchmark problem and every benchmark, human, and agent
   interaction in order. Retain the raw append-only log outside the agent's
   readable workspace.
2. Classify each event as `problem`, `auxiliary`, `essential`, `core`, or
   `unclear`. Never force an uncertain contribution into a passing class.
3. Reference local content and artifact files in a private trace manifest. Run
   `bun scripts/preflight.ts submission preflight.json private-trace.json`.
4. Inject the evaluator capability only at the authenticated boundary and send
   `output.submission` to `POST /harness/autonomy/receipts`.
5. Cite the returned `receiptID` as `autonomyReceiptID` in the final evaluation.

The script hashes raw content, the final artifact, the recorder, and the whole
raw log; it never emits raw prompts or the evaluator token.

## Integrity rules

- The trace must be contiguous, monotonic, complete, and enclose candidate
  creation. A candidate receipt must match its registered artifact SHA-256.
- Human `essential` or `core` input plus substantive agent input derives
  `human_ai_collaboration`; substantive human input with only auxiliary AI
  derives `primarily_human`; substantive AI without essential human input
  derives `essentially_autonomous`.
- A problem statement or auxiliary exposition does not by itself downgrade an
  autonomous result. Any `unclear` contribution makes the receipt inconclusive.
- One run or candidate gets one canonical receipt. An unfavorable trace cannot
  be replaced after inspection.
- Hashes authenticate bytes and ordering, not semantic labels. A qualified
  evaluator must retain the raw interaction evidence for audit.
