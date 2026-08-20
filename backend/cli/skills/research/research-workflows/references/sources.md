# Workflow: sources

<invocation>
$ARGUMENTS
</invocation>

## Admission

Resolve the artifact, claim family, manuscript section, figure, dataset, method, or session output in scope. Extract atomic material claims before searching. Keep one ledger row per claim; do not let one citation stand in for several different propositions.

## Source hierarchy

Prefer the original paper, dataset record, standard, specification, official documentation, or immutable project artifact. Use reviews and summaries to discover primary sources, not as automatic substitutes. Preserve DOI, accession, repository revision, software version, release date, license, and access date where relevant.

## Procedure

1. For each claim, classify the needed support: definition, method, data identity, numerical result, causal claim, limitation, or prior-art statement.
2. Open and inspect the exact source passage, table, figure, code revision, or provenance node. A search snippet, generated answer, title, or abstract is insufficient when the full source is available.
3. Check entailment: the source must support the nearby wording, population, conditions, direction, magnitude, and uncertainty. Flag citation drift, overgeneralization, and causal upgrades.
4. Check identity and currency: version, date, superseding work, corrections, retractions, dataset release, and software API behavior.
5. Check reproducibility metadata: data access, license, sample definition, methods, parameters, and immutable references.
6. Trace generated figures and numbers to workspace artifacts and provenance. Generated text is not evidence for its own claims.
7. Record exact source lineage through provenance tools when a resolvable claim target exists.

## Source ledger

Return columns for claim, exact source, inspected location, support state, version or date, and issue. Use only:

- `SUPPORTED`: source directly entails the claim.
- `PARTIAL`: source supports a narrower or qualified form.
- `MISMATCHED`: cited source does not support the stated claim.
- `MISSING`: no source is attached or identified.
- `UNAVAILABLE`: a named source could not be inspected.

## Terminal condition

End with the exact unsupported or overclaimed statements that block release or publication and the smallest wording, evidence, or citation change needed for each. Do not invent metadata, quotations, identifiers, or URLs.
