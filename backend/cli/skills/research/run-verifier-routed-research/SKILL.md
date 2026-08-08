---
name: run-verifier-routed-research
description: Execute one OpenScience verifier_loop work unit as a generator, targeted reviser, evidence investigator, or independent verifier. Use when coalition_ready returns a verifier-routed-v1 unit and the worker must honor clean-restart context isolation, structured severity verdicts, observable evidence, and the backend-owned attempt budget without choosing its own next route.
---

# Run Verifier-Routed Research

Execute exactly the bound unit. The orchestration backend owns routing; worker text cannot accept a candidate or request its preferred retry.

## Workflow

1. Save the complete `coalition_ready` work object as JSON and run `python3 scripts/validate_unit.py <work.json>`. Stop on validation failure.
2. Read [references/protocol.md](references/protocol.md) before handling a role or verdict format that is unfamiliar.
3. Use only the direct `context` supplied by the unit:
   - `initial-candidate`: build an independent complete candidate.
   - `clean-restart-*`: start from a blank solution using verifier summaries only as failure constraints. Do not reconstruct or minimally edit the rejected candidate.
   - `targeted-revision-*`: correct the cited failed checks, preserve supported components, and return a complete replacement artifact.
   - `evidence-investigation-*`: acquire evidence or counterexamples for inconclusive checks; do not edit the candidate.
   - `repair-verification-*`: independently inspect the candidate and observable evidence without reading another verifier's verdict.
4. Stay within the unit's allocation. Use task-appropriate tools to create durable artifacts and evidence references.
5. Return one structured result with `summary`, `artifactRefs`, `evidenceRefs`, and actual `usage`. Verification units must also return `verdict` with `decision`, `severity`, `confidence`, and evidence-backed `checks`.

## Verdict rules

- `support` + `none`: every declared check passed.
- `reject` + `minor`: a localized correction can preserve the candidate's premise.
- `reject` + `critical`: the premise, interpretation, or global reasoning is invalid.
- `abstain` + `unknown`: available evidence cannot decide at least one material check.

Never weaken a critical defect to obtain a revision, call missing evidence a minor defect, or claim support from confidence alone. Every check needs at least one observable evidence reference.

## Integrity rules

- Do not inspect hidden tests, evaluator internals, another verifier's output, or omitted ancestor artifacts.
- Do not add dependencies or resume another worker session.
- Treat summaries as provisional and evidence references as pointers, not proof by themselves.
- Report failure instead of fabricating artifacts, checks, resource usage, or a conclusive verdict.
- Do not claim benchmark improvement or scientific acceptance; only evaluator settlement can promote a result.
