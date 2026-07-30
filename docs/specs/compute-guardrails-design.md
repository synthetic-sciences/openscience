# Managed compute budget cap — design

Status: approved, ready for implementation planning
Date: 2026-07-30
Roadmap items: **55** (budget guardrails + kill switches), **103** (cost approval gates), and the gate half of
**51/2** (agent-facing compute tool)

Spans two repos. This document is the **contract**; each side gets its own implementation plan because they
have separate test runs and deploys.

- `atlas` (Python/FastAPI) — the decision and the enforcement
- `openscience` (Bun/TypeScript) — a thin client that relays a proposal and obeys the verdict

> **The Atlas behaviour described below was read from source, not verified at runtime.** Treat every claim about
> current behaviour as "what the code appears to do" and confirm against the deployed service before relying on
> it. The prototype models each such assumption as a toggle for exactly this reason.

## The problem, stated narrowly

The agent can start GPU work and nothing bounds the cost. `POST /api/compute/leases` checks only that the
wallet can fund **one hour**, so a 4-hour job on a 1-hour balance is approved and then strands mid-run — the
prototype confirmed this: a 4-hour H100 at $6.99/h against a $15.00 wallet is **approved at a cost of $27.96**.

Roadmap **51/2** — exposing compute to the agent as a tool — is gated on fixing that. Wiring an LLM to an
unmetered spend path would be materially worse than today's human-only exposure.

## The scoping decision that shapes everything below

Two different problems kept getting tangled during design. They are separated deliberately here.

|                  | Problem                                        | Status                                          |
| ---------------- | ---------------------------------------------- | ----------------------------------------------- |
| **Safety**       | Don't spend more than was authorised           | **This spec. Completely solvable now.**         |
| **Productivity** | Don't waste money on a run that gets truncated | Needs roadmap **56** (checkpointing). Not this. |

An earlier draft of this design tried to solve both, and grew a warning event, an extension-request path, a
per-lease `expires_at`, and client-side early release. Every one of those was an attempt to make a run
_succeed_, not to stop a bill running away — and each depended on something that does not exist (a completion
signal for arbitrary SSH commands, a live agent session outliving a long job, or checkpointing).

**This spec solves safety completely and does not pretend to solve productivity.** What that costs is stated
under "What you are accepting".

## Trust boundary

**The agent proposes; the server decides.** The proposed budget is untrusted input.

This is structural, not stylistic. OpenScience is open-source, so a decision made client-side is one a fork can
delete — and the agent has `bash`, so it is running _inside_ the client. Only a decision made over HTTP, behind
auth, in a process the agent is not running, is one it cannot influence. The gate is real only if it is remote.

Corollary: **OpenScience holds no pricing logic, no balance logic, and no approval logic.** It relays a proposal
and obeys a verdict.

## Why budget rather than duration

The agent proposes _"this is worth up to $30"_, not _"this needs 4 hours"_.

**An agent can judge the first and cannot predict the second.** "Is this experiment worth $30?" is a value
judgement LLMs handle well. "Will this converge in 4 hours?" is a prediction about a novel training run that
nobody can make — and a wrong duration estimate is what created the need for an extension path, a warning
window, and a re-estimation loop in the earlier draft.

Three consequences, all simplifying:

- **No completion signal needed.** Budget exhaustion is a fact the server observes. There is nothing to detect,
  which matters because a lease is a VM, not a job — `POST /compute/leases` has no notion of the work running on
  it, and the only completion signal anywhere (`agent_telemetry` rows with `done`/`error_trace`) is written by
  the Atlas agent runtime, not by an arbitrary command run over SSH.
- **No extension path needed.** Exhaustion is arithmetic, not a guess that might need revising.
- **No agent liveness needed.** The server enforces whether or not the session that started the job survived.

And it uses a primitive that already exists rather than adding one — see below.

## What to build

### Atlas — change 1: make `hard_cap_cents` a real running cap

`compute_grants.hard_cap_cents` already reads like a running spend ceiling. It is not one: `acquire_lease`
debits it **once, for one hour**, and the billing tick then calls `usage_service.charge` + `mark_billed` without
ever calling `debit_grant` again. So `spent_cents` freezes at hour one and the atomic ceiling in
`compute_repo.debit_grant` (`AND (spent_cents + ?) <= hard_cap_cents`) is never re-evaluated.

The fix: **the billing tick re-debits the grant by the same delta it charges.** When the debit would exceed the
cap, release the lease — reusing the path that already fires when the wallet runs dry
(`compute_billing_service` catching `InsufficientCredits` → `_safe_release`).

**This is not a double charge.** The grant and the wallet are different ledgers: the wallet is money, the grant
is an authorisation envelope drawn against it. The tick already debits the wallet via `usage_service.charge`; it
will now also decrement the envelope. Two records, one charge. An implementer who "de-duplicates" these has
removed the cap.

This is the whole feature. It is a small change to money-handling code, so it lands as **its own commit with its
own tests**, separate from change 2, so a failing `fly deploy -a thesis-dev` can be attributed to one or the
other.

### Atlas — change 2: accept a budget on lease creation

```
POST /api/compute/leases
Request:  { provider, sku, region?, node_id?, budget_cents?: number }
```

`budget_cents` is **optional**, and this matters: the Atlas dashboard already calls this endpoint
(`frontend/src/api/account.ts:284`) without it, and so does `atlas compute:up`. Absent means today's behaviour —
grant sized to the plan TTL at the hourly rate. Present means the grant is sized to `budget_cents` instead, and
change 1 then enforces it.

Rejection reuses the existing structured `402`, extended with what _would_ fit:

```
402 { error: "insufficient_cli_credit", needed_cents, available_cents,
      affordable_budget_cents, actions: ["byok", "topup"], message }
```

**A budget larger than the wallet is clamped, not rejected.** The wallet is always the outer bound — if it
empties first, the existing exhaustion path releases the lease regardless of what the grant permits. So a
$1000 budget against a $15 balance is not an error, it simply buys $15 of compute. But the caller must not be
left believing otherwise: the response reports the **effective** cap (`min(budget_cents, effective_balance)`)
so the agent can tell the user what was actually authorised rather than what was asked for.

**Managed leases only.** BYOK runs on the user's own provider account, which we neither meter nor bill, so a
budget cap there would be a number we cannot enforce. BYOK ignores `budget_cents`.

### OpenScience — one tool

The agent lists options, picks a SKU itself, and proposes a budget:

1. `GET /api/compute/options` → the agent sees live per-SKU rates and picks. **Selection is the agent's job**,
   which is why OpenScience needs no selection logic and no wrapper around `compute:up`.
2. Submit `{provider, sku, budget_cents}`. **Refuse to launch without a verdict that came back from Atlas.**
3. On `402`, surface `affordable_budget_cents` to the user and stop. **Never auto-retry at a smaller budget** —
   a truncated training run is not a cheaper result, it is a discarded one, and an agent that quietly downsizes
   scientific work produces invalid output while appearing to succeed.
4. On `429` (concurrency cap, currently 2 managed GPU leases), surface it rather than retrying.
5. Release on request. **No client-side deadline timer** — the server is the enforcer, and the client has no
   completion signal to improve on it with.

## The two clocks that remain

| Bound            | Owner               | Fires when                     |
| ---------------- | ------------------- | ------------------------------ |
| `hard_cap_cents` | Atlas billing tick  | the approved money is spent    |
| Plan TTL (24h)   | Atlas billing sweep | anything has run absurdly long |

Both already exist as mechanisms; only the first is being made functional. **No `expires_at` column is added** —
time is not the thing being authorised, and a second time bound alongside the plan TTL would be redundant.

Billing ticks every 60 seconds, so a budget can overrun by up to a minute of rate (~$0.12 on an H100). Approved
budgets are therefore ceilings-plus-a-minute and must never be described as exact.

## What you are accepting

**A budget-exhausted job loses its work.** You paid the budget and got a partial run. This is already true
today; the spec does not make it worse, but it does not fix it either. **Roadmap 56 (checkpointing) is the fix,
and should be tracked as the follow-on that makes this good rather than merely safe.** Until then, a warning
event before exhaustion would be advice nobody can act on.

**Time is unbounded within a budget.** A cheap CPU lease could run for days inside a small budget. The 24-hour
plan TTL is the only backstop, which is deliberate.

## Testing

**Atlas** follows `backend/tests/test_compute_billing.py`: a `_FakeProvider` registered into the provider
registry, `aiosqlite` + `run_migrations` for an isolated DB, assertions on the verdict and on whether release
was called. Runs under plain `pytest` before the `fly deploy -a thesis-dev` check, so the deploy verifies
integration rather than being the code's first execution.

Cases that must be covered:

- A tick whose delta would exceed `hard_cap_cents` **releases the lease**; one that fits does not.
- `spent_cents` tracks cumulative charge across several ticks rather than freezing after the first.
- A lease created **without** `budget_cents` behaves exactly as before (dashboard and `compute:up` compatibility).
- A budget smaller than one hour's rate is rejected at creation with a `402` carrying
  `affordable_budget_cents`.
- BYOK leases ignore `budget_cents` and are never debited.
- A budget larger than the wallet is clamped, and the response reports the effective cap rather than the asked-for one.
- The plan TTL still fires independently of any budget.

**OpenScience** follows its house pattern — stub `globalThis.fetch`, exercise the real tool. Cover: refusing to
launch without a verdict, surfacing `402` without retrying, surfacing `429`, and release.

Every new assertion must be shown failing against the specific mutation it guards before being committed. On the
preceding `science_fetch` branch, seven assertion defects were found and **all seven were in plan-authored test
code**; the ones that held up were proven against a _deletion_, not merely an inversion.

## Migration

`compute_grants.hard_cap_cents` already exists — no schema change for change 1. Change 2 adds no column either;
`budget_cents` only sizes the grant at creation. Existing in-flight grants keep whatever cap they were created
with, and change 1 begins enforcing it from the next tick, which is the safe direction.

## Corrections to earlier analysis

Recorded because both errors reached a draft of this document.

- **`atlas compute:up` exists.** It is at `cli/src/atlas-runtime/commands.mjs:922` as a `LOCAL` command (aliases
  `compute:launch`, `compute:lease`), alongside `compute:list` and `compute:ssh`. An earlier draft claimed it
  existed in no version — that was wrong, caused by a comment two lines below it saying compute provisioning is
  not part of the CLI. **Consequence: the system prompt at `session/prompt.ts:1554-1562` is not broken** and
  needs no fix. It was previously an acceptance criterion; it is removed.
- **`compute:up` already takes `max_price` and `dry_run`.** A per-hour price ceiling and a no-spend preview
  already exist in the CLI's parameter set, closer to this design than earlier drafts represented. Adding
  `budget_cents` to `compute:up` as well would let CLI users have the same cap — worth doing, out of scope here.

## Out of scope

- **Roadmap 61** (per-job secrets, never into logs) — belongs to the _local_ runner `compute/jobs.ts`, which has
  no billing involvement. Logs there go straight to a file descriptor unredacted while every job inherits the
  user's Modal, RunPod, Lambda, Vast, W&B and HuggingFace keys. Real problem, separate workstream.
- **Roadmap 56** (checkpointing) — the follow-on that makes budget exhaustion survivable.
- **Roadmap 4** (real BYOK provider API clients) — five separable vendor integrations.
- **Roadmap 52** (`bun:sqlite` for the local runner's state).
- Adding `budget_cents` to `atlas compute:up`, a per-lease `expires_at`, warning events, extension requests,
  client-side deadline timers, and any client-side price table.

## Acceptance criteria

1. The billing tick re-debits the grant, so `spent_cents` tracks cumulative spend instead of freezing at hour
   one.
2. A tick whose delta would exceed `hard_cap_cents` releases the lease via the existing release path.
3. `POST /api/compute/leases` accepts optional `budget_cents` and sizes the grant to it.
4. Omitting `budget_cents` preserves today's behaviour exactly — the dashboard and `compute:up` keep working.
5. A budget that cannot fund the first hour is rejected with `402` carrying `affordable_budget_cents`.
6. A budget exceeding the wallet is clamped to the effective balance, and the response reports the effective cap.
7. BYOK leases ignore `budget_cents` and are never debited.
8. The 24-hour plan TTL still fires independently.
9. `pytest` passes with no network access; change 1 is a separate commit with its own tests.
10. The OpenScience tool refuses to launch without an Atlas verdict, surfaces `402` and `429` without retrying,
    and holds no pricing or approval logic.

## Prototype

`backend/cli/src/compute/PROTOTYPE-guardrail-model.ts` and `PROTOTYPE-guardrail-repl.ts` (openscience,
`e12e486`), runnable via `bun run prototype:guardrail`. It was built duration-first, so its `decide()` reasons
about hours rather than a budget — the _gate-mode_ finding (first-hour versus total) is what carried over and
motivated this design. Each unverified Atlas behaviour is a toggle, so verifying the real backend means flipping
switches rather than rewriting the model.
