# Workflow: plan

<invocation>
$ARGUMENTS
</invocation>

## Admission

- Infer an empty invocation from the active user request and session state. Ask only if two materially different objectives remain plausible.
- Enter and remain in the read-only plan agent. Inspecting files, history, tests, schemas, and documentation is allowed; implementation edits, dependency changes, commits, pushes, deployments, and other mutations are not.
- Treat the plan file as the sole writable implementation artifact during planning.

## Procedure

1. Resolve the objective, boundaries, non-goals, user-visible outcome, and completion evidence.
2. Read applicable `AGENTS.md` or equivalent instructions and trace the real entry path through affected interfaces, state stores, side effects, and tests. Find existing abstractions before proposing new ones.
3. Inspect current session todos, research contract, artifacts, failures, and relevant git state so the plan continues existing work instead of duplicating it.
4. Identify invariants and failure surfaces: admission, permissions, persistence, retries, cancellation, interruption, concurrency, partial writes, recovery, compatibility, and migration.
5. Evaluate alternatives only when the choice changes the architecture. Record the selected approach and why it wins; do not dump brainstorming into the final plan.
6. Write a bounded dependency-ordered plan with `planwrite`. Use three to seven concrete steps for ordinary work. Name critical paths and the behavior each step changes.
7. Include acceptance criteria and verification: focused tests, end-to-end path, regression coverage, and any state or artifact inspection required to prove success.
8. Re-read the plan against the request and repository instructions. Remove speculative work, redundant abstractions, and steps that cannot be verified.

## Terminal condition

Call `plan_exit` only when the plan file is decision-ready and internally consistent. If a blocking product choice remains, ask that one question and keep planning. Do not implement from this command.

## Final plan shape

- Objective and non-goals
- Verified current behavior and relevant paths
- Ordered implementation steps with file or subsystem scope
- Failure, cancellation, and compatibility behavior
- Verification and acceptance criteria
- One unresolved decision, only if genuinely blocking
