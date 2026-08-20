# Workflow: verify

<invocation>
$ARGUMENTS
</invocation>

## Admission

Resolve the target from the invocation, active plan, request, research contract, and claimed result. Convert every material claim into an observable acceptance criterion before running checks. If a research contract exists, inspect it with `research_contract` action `status`; do not replace it with a conversational checklist.

## Procedure

1. Build a verification ledger with criterion, evidence path, expected result, and current state.
2. Run the smallest real check that can falsify each criterion, then broaden in proportion to risk. Prefer repository-provided typecheck, test, build, lint, integration, or reproduction entry points.
3. Exercise the real implementation. Avoid mocks unless the repository's established test boundary requires them, and never duplicate the implementation logic inside the test.
4. For research outputs, recompute decisive quantities from declared inputs where feasible. Check units, shapes, sample counts, exclusions, seeds, environments, tolerances, uncertainty, statistical assumptions, source support, and figure-to-data consistency.
5. Use a clean rerun or independent formulation for fragile results. Include a negative control or failure-path check when false success is a material risk.
6. Inspect output files and durable artifact versions directly. A successful process exit does not prove that the intended result was produced.
7. Update `research_contract` checks only after evidence exists: `passed` for observed satisfaction, `failed` for observed contradiction, and leave absent checks pending when not tested.

## Constraints

- Do not edit implementation merely to make verification pass unless the user requested a fix.
- Do not weaken assertions, change the metric, skip a failing path, or relabel an unavailable dependency as success.
- Distinguish static inspection from execution and local checks from CI or remote checks.

## Terminal condition

Return a ledger where each criterion is exactly `PASS`, `FAIL`, or `NOT TESTED`, followed by the commands or records used and the precise remaining gap. Overall status is `PASS` only when every required criterion passes; any failed criterion yields `FAIL`; otherwise return `NOT TESTED`.
