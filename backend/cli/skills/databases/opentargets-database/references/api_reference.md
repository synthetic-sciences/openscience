# Open Targets Platform API reference

## Endpoint and schema

The public endpoint is `https://api.platform.opentargets.org/api/v4/graphql`.
Send POST JSON with `query` and optional `variables`. No key is required.
Use the [GraphQL browser](https://api.platform.opentargets.org/api/v4/graphql/browser)
or schema introspection to verify fields. Query contracts below were checked
September 5, 2026; data releases may change them.

The API is for exploratory queries. Use official data downloads or BigQuery for
systematic analyses rather than issuing large numbers of API requests.

## Bundled helper contract

`scripts/query_opentargets.py` exports:

- `search_entities(query_string, entity_types=None)`: first 10 matching hits.
- `get_target_info(ensembl_id, include_diseases=False)`: target annotations,
  optionally the first 10 associated diseases.
- `get_disease_info(efo_id, include_targets=False)`: disease annotations,
  optionally the first 10 associated targets.
- `get_target_disease_evidence(ensembl_id, efo_id, data_types=None)`: first 100
  evidence rows, optionally filtered locally by datatype. A filtered empty page
  does not establish that no matching evidence exists.
- `get_known_drugs_for_disease(efo_id)`: current `drugAndClinicalCandidates`
  response, with `count` and `rows`. Each row includes `id`,
  `maxClinicalStage`, and nullable `drug`.
- `get_drug_info(chembl_id)`: drug identifiers, stages, warnings, mechanisms and
  indications in the current nested shapes.
- `get_target_associations(ensembl_id, min_score=0.0)`: first 100 associations,
  filtered locally by score.
- `execute_query(query, variables=None)`: custom GraphQL query, with a 30-second
  HTTP timeout and GraphQL errors surfaced even when the HTTP status is 400.

For absent entities, dictionary helpers return `{}` and row helpers return `[]`.
Transport or schema failures raise an exception instead; do not treat them as
negative biological evidence.

## Pagination

Every explicit `Pagination` object needs both required integer fields:
`page: {size: 10, index: 0}`. The index is zero-based. Set the next index for the
next page and check the upstream count/rows; do not label one page "all results".
Evidence uses the separate `size`/`cursor` interface, not `page`.
The current evidence argument is `datasourceIds`, not `datatypes`; these represent
different concepts and must not be substituted for one another.

## Current field shapes

- Association `datatypeScores` has `id` and `score`. The helpers alias `id`
  to `componentId` for compatibility with existing consumers.
- Safety effects have `direction` and optional `dosing`; biosamples expose
  `tissueLabel` and `tissueId`, not a nested `tissue` object.
- `Disease.knownDrugs` has been replaced by `drugAndClinicalCandidates`.
  Its rows are clinical candidate records, not the old drug-target-trial rows.
- Drugs expose `maximumClinicalStage` as a string. Do not manufacture a numeric
  phase or approval state.
- Drug synonyms are `{label, source}` objects. Mechanisms use
  `mechanismsOfAction { rows { actionType mechanismOfAction targetName targets { id approvedSymbol } } }`.
- Indications use `indications { count rows { disease { id name } maxClinicalStage } }`.
  Warnings use `drugWarnings`, not `withdrawnNotice`.

## Example

```python
from scripts.query_opentargets import search_entities, get_target_info

hits = search_entities("BRCA1", ["target"])
if hits:
    target = get_target_info(hits[0]["id"], include_diseases=True)
    for row in (target.get("associatedDiseases") or {}).get("rows", []):
        print(row["disease"]["name"], row["score"])
```

Association scores are relative rankings, not calibrated probabilities of
clinical success. Review evidence sources and biological context. Cite the
[Open Targets Platform](https://platform.opentargets.org) and the applicable
release/publication in research outputs.
