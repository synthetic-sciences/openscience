# Workflow: reproduce

<invocation>
$ARGUMENTS
</invocation>

## Admission contract

Resolve the exact source, claim, result, metric, expected value, uncertainty or tolerance, and success criterion. Identify what evidence would support, partially support, contradict, or leave the claim untested. Do not execute while the criterion can still move after seeing the result.

Recover or explicitly mark missing:

- immutable code revision and dirty-state caveat;
- data identity, version, split, filters, exclusions, and license or access boundary;
- environment, dependencies, hardware-sensitive settings, and random seeds;
- configuration, command, checkpoint, and expected output artifacts.

## Durable setup

1. Inspect existing research contract state. If the work is multi-stage and no compatible contract exists, define one before expensive execution with the appropriate domain and empirical template.
2. Mark setup stages only when inputs are resolved. Save a compact manifest or rerunnable driver early when the reproduction would otherwise depend on hidden shell or kernel state.
3. Preserve existing outputs. Write new runs to an isolated, collision-resistant location and keep raw logs separate from derived summaries.

## Execution

1. Run the repository's canonical reproduction path before inventing a replacement.
2. Capture the exact command, exit status, versions, seed, configuration, elapsed time, metrics, warnings, and artifact paths.
3. Record each materially distinct failed or inconclusive candidate with `research_contract` action `failure`, including disposition. Inspect an interrupted side effect before retrying; never assume it did not happen.
4. Rerun decisive computations from a clean process or declared environment. Check determinism or expected stochastic variability.
5. Compare reproduced and reference results using the frozen metric, direction, uncertainty, and tolerance. Report absolute and relative differences only when meaningful.
6. Save final files as durable Results and connect exact claim lineage through provenance tools. Run the relevant verification checks before marking stages complete.

## Scientific controls

Apply only those relevant to the domain, but do not omit a material one: leakage-safe splits, positive and negative controls, convergence or conservation checks, identifiability, calibration, multiple-testing treatment, unit consistency, checkpoint reload, and data/figure consistency.

## Terminal condition

Return exactly one verdict:

- `SUPPORTED`: criterion met and required validation passed.
- `PARTIALLY SUPPORTED`: direction or subset reproduced, with a named material gap.
- `CONTRADICTED`: valid reproduction evidence conflicts with the claim.
- `NOT TESTED`: missing inputs, compute, permission, or failed setup prevented a valid test.

List the evidence nodes or paths, exact commands, observed metrics, failed attempts, and next discriminating action. Never upgrade a close or merely plausible result to support.
