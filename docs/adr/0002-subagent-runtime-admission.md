# ADR 0002: Subagent allowances are runtime admission controls

Status: Accepted
Date: 2026-11-04

## Context

The optional `harness.budget` and `harness.cost` units guide the research loop
through environment context and finish hooks. They can be disabled. Bounded
subagent runs instead implement an explicit user setting: a shared inference
allowance and a deadline for each admitted assignment.

A finish hook cannot stop a new physical transport retry or a tool that starts
after cancellation. Internal model calls and calls outside the visible assistant
step also need the same owner and allowance. Making these checks optional under
a harness switch would let disabling research guidance disable an approved limit.

## Decision

Keep scientific policy and optional continuation guidance in harness units.
Keep bounded subagent admission, transport reservation, reconciliation and
cancellation below those hooks, in the runtime:

- Task resolves and persists the child contract before starting work.
- LLM resolves the pinned model/route and bounds the prepared request.
- ModelCallTrace reserves each physical dispatch, including retries, and
  reconciles actual usage or a definite admission rejection.
- The shared Tool wrapper rejects work after a worker stops or its deadline
  expires. This applies even when a model ignores the brief.

The root conversation fixes bounded mode on its first admission. With mode off,
the runtime does not create child budget bindings or deadline watches. The
main agent remains outside the child allowance. Disabling `harness.budget` or
`harness.cost` does not disable a bounded child contract.

Child-owned internal model work uses that child's pinned model and route and
counts against its allowance. This intentionally overrides the configured
small-model selection inside bounded children: a cheaper internal call must not
silently move a subscription assignment to paid access or escape ownership.
Main-owned internal calls retain normal small-model selection. Separate pinned
internal-model contracts would require explicit routing and pricing semantics.

Input reservation uses the shared multilingual text heuristic, media token
estimates, actual offered tool JSON schemas and a margin. It is not a tokenizer
or a promise about the final provider bill. Reported usage remains authoritative;
an accepted overrun stops later calls. Rejected admission statuses return their
reservation. Timeouts, conflicts, transport failures and server errors remain
uncertain unless usage is reported; an empty error body does not establish zero
inference cost.

## Trust boundary

These are controls on cooperative use of the trusted local service, not process
isolation from the machine's owner or arbitrary code running as that owner.
Session scope, revision and idempotency checks prevent accidental cross-session
and duplicate increases. They do not prove that a human clicked the UI.

A shell, plugin or SDK client with access to the local control API can submit
an increase. Code that can write the service's state files can also modify its
ledger directly. A token available through the same local API or filesystem
would not establish a separate human authority boundary. Host/Origin checks and
an optional deployment bearer token do not isolate trusted clients from each
other. Run untrusted code behind an execution boundary that denies access to
both the control API and service state. Stronger human-only approval needs a
separate trusted control channel and is not provided by this feature.

## Consequences

The session loop calls a small set of admission services even when optional
research harness units are off. This is a documented exception to the earlier
statement that the loop knows nothing about budgets. Pricing, ledger arithmetic
and stop policy stay in the subagent modules instead of spreading into harness
hooks. Harness plugins cannot bypass the transport or tool boundary.

Pool JSON parsing and settled-call retention can still grow with conversation
length. Future profiling work can change storage and caching without weakening
cross-process ownership, late settlement, idempotency or cancellation behavior.
