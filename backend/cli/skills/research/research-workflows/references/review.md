# Workflow: review

<invocation>
$ARGUMENTS
</invocation>

## Admission and scope resolution

- With no target, review every current uncommitted change: unstaged diff, staged diff, and complete untracked files.
- For a commit, inspect the commit and its parent. For a branch, use the merge base with `HEAD`. For a pull request, inspect metadata, description, full diff, review threads, and checks. For an artifact, claim, figure, or result, resolve its immutable version and provenance.
- Refuse to collapse an ambiguous target into a confident review. State the exact reviewed range before judging it.

## Context collection

1. Read repository instructions that govern each changed path.
2. Read every changed file in full plus enough callers, schemas, tests, and lifecycle code to trace the affected behavior. A diff alone is insufficient.
3. For scientific work, trace claims and numbers to source records, code, data, environment, generated artifacts, and verification evidence. Check units, uncertainty, statistical assumptions, leakage, controls, and figure-to-data consistency where relevant.
4. Inspect failure, cancellation, retry, permission, persistence, and concurrency paths when the change touches lifecycle state or side effects.

## Finding validation

- Generate candidate findings, then try to disprove each one against the surrounding implementation and tests.
- Report only defects introduced by the reviewed scope, unless a pre-existing issue is made reachable or materially worse by it.
- Do not report style preferences, speculative edge cases with no realistic trigger, issues a normal static check already states more precisely, or test gaps without a concrete untested failure.
- When a validated scientific finding should persist, record it as a claim through `provenance_record`
  and derive it from the resolved target or evidence. Do not use reserved historical review metadata.
  Keep exploratory concerns out of durable provenance until validated.

## Finding contract

For each validated finding provide:

1. Severity: blocking, major, minor, or info.
2. Exact target: file and tight line range, artifact version, claim, figure, or provenance node.
3. Trigger: the concrete input, state, or environment required.
4. Evidence: what was inspected or run and the observable contradiction.
5. Impact: the incorrect behavior or scientific risk.
6. Smallest complete fix. Do not suggest a partial patch that leaves the defect active.

## Terminal condition

Finish with findings ordered by severity. If none survive validation, state `NO BLOCKING FINDINGS` and list the reviewed scope and checks actually performed. Do not modify the reviewed work and do not post external comments unless the user explicitly requested posting.
