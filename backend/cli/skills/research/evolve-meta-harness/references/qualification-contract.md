# Qualification contract

## Bound before search

`meta-harness-v1` commits the baseline artifact and manifest; mutable component roots; protected manifest and roots; validator, archive-schema, and trace-schema hashes; distinct updater and adherence-judge identities; disjoint sorted search and held-out model IDs plus weights/config commitments and task IDs plus content commitments; and all promotion thresholds. Each split must contain an activation-required task. The bound beneficiary model belongs to the search set, never the held-out set.

The qualifier capability must differ from optimization evaluation, evaluator audit, semantic audit, and sealed confirmation. The adherence judge must differ from the updater, optimization evaluator, and claim evaluator.

## Archive entries

One entry is required for every search candidate, sorted by candidate ID. For this protocol the search artifact is the exact evolution-source snapshot, not a mutable pointer or separately packaged surrogate. An evaluated entry includes that source hash; exact result-metric, result, and evaluation hashes; and a complete raw trace with the frozen schema. An unevaluated entry has no result or trace fields. Hidden task content and evaluator implementation are excluded from the trace archive.

Evolution capture must cover every mutable and protected root. The candidate manifest is derived from the selected evolution snapshot's sorted `{path, sha256}` pairs. The protected subset is derived from the same bytes and must reproduce the frozen protected-manifest hash; echoing a trusted-looking hash without matching source files fails.

The index hash is SHA-256 of JavaScript `JSON.stringify(entries)`. The archive hash is SHA-256 of `JSON.stringify` over the archive object without its `sha256` field, in protocol field order. Use the builder rather than hand-computing these hashes.

## Refinements

Revisions are contiguous from one. Revision one descends from the frozen baseline artifact; each later revision descends from the preceding snapshot; the last snapshot equals the backend-selected candidate artifact. Changes are sorted, unique, confined to exactly one declared mutable root, and labeled with the matching component type.

Every revision includes a trigger, failure diagnosis (`implementation`, `fundamental`, or `inconclusive`), root cause, expected outcome, at least one archived trace citation, and sorted search-only predictions. Predictions are unique across the lineage. Held-out cells cannot appear in refinement evidence or predictions.

## Qualification cells

Provide one baseline and one candidate cell for every cross product:

- every search model × search task;
- every held-out model × held-out task.

Sort by `split`, `modelID`, `taskID`, then `role`. Every cell echoes the frozen model and task commitments; reusing an ID for changed bytes is rejected. Completed cells require numeric score and pass verdict. Failed or inconclusive cells publish neither. Every cell includes context tokens, output hash, complete trace, and evidence.

Candidate cells add `loaded` and phase observations. If an activation-required completed cell loaded the harness, all four canonical phases are required. Counts distinguish followed, commission violation, omission violation, required-but-unobserved, not applicable, and insufficient evidence.

## Backend-derived firewall

Direction-normalized gains use candidate minus baseline for maximize metrics and baseline minus candidate for minimize metrics. Promotion requires search and held-out mean gains, per-model regression bounds, activation and adherence floors, phase-drift and context ceilings, prediction precision, and risk-regression limits. Any failed cell or numeric threshold breach fails. Missing or insufficient evidence is inconclusive. Both states block sealed confirmation permanently for that session receipt.
