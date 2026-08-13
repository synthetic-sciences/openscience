# Project record templates

Use only the records the task needs.

## Analysis brief

```markdown
# Objective
# Deliverables
# Inputs and versions
# Assumptions
# Method
# Validation
# Permissions and external actions
# Stopping conditions
```

## Data manifest

```json
{
  "created_at": "ISO-8601",
  "sources": [],
  "license_or_terms": "",
  "files": [
    {"path": "", "sha256": "", "bytes": 0, "schema": {}, "notes": ""}
  ]
}
```

## Experiment ledger row

```json
{
  "experiment_id": "",
  "timestamp": "",
  "hypothesis": "",
  "data_version": "",
  "split_version": "",
  "code_or_artifact_version": "",
  "features": [],
  "model": "",
  "parameters": {},
  "seed": null,
  "metrics": {},
  "runtime": {},
  "status": "completed|failed|aborted",
  "decision": "",
  "notes": ""
}
```

## Evidence row

```json
{
  "source_id": "DOI|PMID|accession|URL",
  "citation": "",
  "design": "",
  "population_or_system": "",
  "sample_size": "",
  "claim_supported": "",
  "effect_and_uncertainty": "",
  "limitations": "",
  "verification": ""
}
```
