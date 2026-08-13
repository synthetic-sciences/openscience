---
name: conducting-scientific-research
description: Conduct rigorous, reproducible multi-step scientific work with literature, databases, local files, Python, R, shell, artifacts, reviewers, and approved compute. Use for evidence synthesis, data or statistical analysis, machine learning, simulation, study design, scientific figures or manuscripts, reproduction audits, and database curation. Do not invoke for a simple timeless science fact that needs no tools or project workflow. Kaggle competitions use the separate kaggle-competition skill.
---

# Conducting Scientific Research

Use this skill when the task is scientific work rather than a single factual explanation. Adapt the procedure to the request; do not force every task through every reference.

## Start

1. Read the project instructions and inspect the referenced files, artifacts, prior sessions, environments, connectors, compute, and reviewer state.
2. Define the requested result and the smallest evidence or execution path that can support it.
3. Read the relevant references below before the first substantive action.
4. Identify the validation gate, durable artifacts, and any new permission or external-action boundary.
5. Execute, validate, save the record, request review when material, address findings, and report the result.

## Reference routing

- Scientific questions, study design, exploration versus confirmation, and manuscripts: [references/scientific-work.md](references/scientific-work.md)
- Literature search, citation checking, evidence tables, and database retrieval: [references/literature-and-retrieval.md](references/literature-and-retrieval.md)
- Data audit, statistics, causal inference, machine learning, and figures: [references/data-statistics-ml.md](references/data-statistics-ml.md)
- Environments, local and remote compute, artifacts, provenance, and review: [references/compute-artifacts-review.md](references/compute-artifacts-review.md)
- Reusable project records and templates: [references/templates.md](references/templates.md)

Read only the references that affect the active work. Keep reference loading one level deep.

## Required behavior

- Never report execution, retrieval, validation, review, or saving unless the record proves it.
- Keep source claims, direct observations, computed values, inferences, and hypotheses distinct.
- Preserve raw inputs and material identity: units, builds, versions, identifiers, filters, joins, exclusions, and query dates.
- Do not rely on hidden kernel state for a durable result; save code and rerun from declared inputs when practical.
- Validate fragile retrievals, joins, models, figures, and artifacts with an independent check.
- Use the least permission necessary. Do not expose credentials or perform an external action without the required approval.

## Default loop

```text
Inspect state → establish objective and evidence → execute → validate
→ save artifacts and provenance → review → correct → report
```

For a simple task, several stages may collapse into one. For a material task, do not omit validation or the durable record merely to finish faster.
