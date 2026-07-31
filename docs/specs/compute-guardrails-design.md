# Managed compute budget cap — design

Status: **REVIVED — ready to plan.** Parked 2026-07-30, revived 2026-07-31.
Date: 2026-07-30 · revived 2026-07-31

> ## ⚠️ Read this before anything below
>
> **The parking condition has expired, and the five findings below are now the implementation checklist —
> exactly as the parked banner instructed.** The design's core (budget not duration, server decides,
> `hard_cap_cents` made real) survives review intact. What changed is that the problem became reachable and
> the gaps became work items.
>
> ### What changed on 2026-07-31
>
> **Managed compute is switched ON in production.** The parked banner's first and load-bearing reason —
> "there is no live overspend to guard" — is false as of a live check against `thesis-synsc`:
>
> ```
> GET /api/compute/options  →  resell_enabled: true
>                              lambda / runpod / vast / prime_intellect  →  funding: "managed"
>                              292 launchable options
> ```
>
> `COMPUTE_RESELL_ENABLED` still _defaults_ to `false` (`backend/app/config.py:383`), which is what the
> original analysis read — but production sets it. **This is the fourth time in this investigation that reading
> source gave the wrong answer about deployed reality** (see "Corrections to earlier analysis"), and the first
> one made _by_ a correction to an earlier mistake. Verify against the running system.
>
> So there is a live, unmetered spend path today: `POST /compute/leases` checks only the first hour, and
> `atlas compute:up` is the human-facing door to it.
>
> ### The prerequisite that blocks everything
>
> **Finding 1 below is not a checklist item — it is a hard prerequisite, and it is a live defect independent
> of this spec.** The lease reaper terminates _any_ lease that emits no telemetry roughly ten minutes after
> creation:
>
> - `compute_repo.list_unfinished_leases` is explicitly category-agnostic —
>   `WHERE status NOT IN ('released','failed')`, no exemption for user leases.
> - `lease_reaper.sweep_once` branch 3 falls back to `_lease_started` (= `started_at or created_at`) when
>   there is no telemetry, and reaps past `HEARTBEAT_STALE_SECONDS` = 600.
> - `create_lease` mints **no runner token**, and `POST /api/agent/runner/telemetry` requires one
>   (`x-thesis-runner-token`, scoped to a lease).
>
> **A user-launched lease therefore has no way to prove liveness, and is destroyed before it is useful.**
> Provisioning eats several minutes of the ten. Until this is fixed, no budget can bind — a $30 budget lease
> dies having spent about $1.17 — and `atlas compute:up` cannot run a research task no matter what else ships.
>
> The fix is to scope heartbeat staleness to leases that are _supposed_ to report: those with a runner token.
> User leases are already bounded by three independent mechanisms — plan TTL, wallet exhaustion, and explicit
> release — and adding a budget cap makes four. They do not need a liveness probe they cannot answer.
>
> ### The five findings, now the checklist
>
> - **The lease reaper kills these leases at ten minutes.** `lease_reaper` sweeps every 60s over all
>   unfinished leases and reaps anything silent for `HEARTBEAT_STALE_SECONDS` = 600. A workload run over SSH
>   emits no `agent_telemetry`, so a $30 budget lease would be terminated having spent about $1.17. The budget
>   would never bind. This also falsifies the claim below that no agent liveness is needed — Atlas requires
>   liveness in the form of telemetry.
> - **`budget_cents` already exists** on the agent-spawn path with a default of `500`
>   (`agent_tools.py:1386`). Making the cap real converts a display-only $5 into a hard kill on a shipped
>   feature. The migration section below calls this a no-op; it is not.
> - **The acquire-time debit is never rolled back**, so re-debiting per tick double-counts hour one. A $10
>   budget at $6.99/h would die at 25.8 minutes rather than ~1.4 hours; a one-hour budget would buy 60 seconds.
>   The test list below does not catch this — the property that matters, _a budget of $B at $R/h lasts ≈B/R
>   hours_, appears in neither the tests nor the acceptance criteria.
> - **Sequential leases are unbounded.** The cap is per-grant and a grant is per-lease, so an agent can release
>   and re-acquire without limit. The concurrency cap of 2 does not bound cumulative spend.
> - **No idempotency on the money path.** The billing tick performs independent committing writes; a crash
>   between them double-charges on the next tick, and adding a grant debit widens the window.
>
> ### Status of the two factual errors
>
> - **"`atlas compute:up` exists"** — still true only of the repo. Verified again 2026-07-31 by unpacking the
>   registry artifact: published `@synsci/atlas@0.13.2` contains **155 command specs and zero `compute:`**.
>   The chronology explains it — `3e1d1ca` removed the compute commands, `0.13.1` and `0.13.2` shipped without
>   them, then `205bbc0` re-added them and four commits developed them further **with no version bump**. `main`
>   still declares `0.13.2`, identical to the artifact that lacks them. The fix is a release, not code.
> - **The system prompt was broken and is now FIXED.** Shipped on `feat/compute-guardrails` — the false
>   `atlas compute:up` / `atlas doctor` guidance is deleted from both `session/prompt.ts` and the `research`
>   agent prompt, replaced by a `compute_status` tool that resolves `byok | managed | none` at runtime.
>
> ### Scope note inherited from that work
>
> `compute_status` now tells an agent in `managed` mode to "run GPU work through managed compute" — and no
> mechanism exists for it to do so. That guidance is honest about funding but not about capability, and it is
> the user-visible reason this document is being revived rather than left parked.

Roadmap items: **55** (budget guardrails + kill switches), **103** (cost approval gates), and the gate half of
**51/2** (agent-facing compute tool)

Spans two repos. This document is the **contract**; each side gets its own implementation plan because they
have separate test runs and deploys.

- `atlas` (Python/FastAPI) — the decision and the enforcement
- `openscience` (Bun/TypeScript) — a thin client that relays a proposal and obeys the verdict

> **Verification status (updated 2026-07-31).** The original draft was written entirely from source, which is
> how it acquired four wrong conclusions about deployed reality. Much of it has since been checked against the
> running system, so distinguish:
>
> - **Verified against production `thesis-synsc`:** reselling is on with four operator providers and 292 live
>   options; `/compute/estimate` returns `funding: "managed"` with a real rate and runway; the published npm
>   artifact contains no `compute:` command; the CLI runs from source and its `compute:up` default path fails
>   on the Vast SKU race while `--provider lambda|runpod` succeeds.
> - **Still read from source only:** the billing tick's debit behaviour, grant accounting, the reaper's exact
>   reap path, and every claim about what changing them would do. Confirm these against the deployed service —
>   or better, against a test — before relying on them.
>
> The prototype models each unverified assumption as a toggle for exactly this reason.

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

**Safety is still what this spec guarantees.** Changes 0–3 are the whole of it, and they depend on nothing
outside Atlas.

The 2026-07-31 revision adds two productivity changes — and the test that admitted them is deliberately narrow:
**does it work when nobody is watching?**

- **Change 4 (volumes) passes.** It moves files off the box before anything fails. It needs no completion
  signal, no live session, and no client cooperation, because the volume simply outlives the pod.
- **Change 5 (extension) passes only because it is optional.** If no extension arrives, exhaustion proceeds
  unchanged. Nothing blocks on a decision, so a dead agent costs nothing.

The rejected features failed that test: each needed something alive to act on a signal. That is the line —
**a productivity feature is admissible here only if its absence changes nothing about enforcement.** A per-lease
`expires_at`, client-side timers, and auto-extension remain out for exactly that reason.

What still isn't solved is stated under "What you are accepting".

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
- **No extension path needed _for safety_.** Exhaustion is arithmetic, not a guess that might need revising.
  An extension is therefore a convenience, never a correctness requirement — see change 5, which adds one
  deliberately and keeps it outside the enforcement path.
- **No agent liveness needed.** The server enforces whether or not the session that started the job survived.
  This is the property change 0 restores: today the reaper demands a liveness signal that a user lease cannot
  produce, which inverts exactly this design goal.

And it uses a primitive that already exists rather than adding one — see below.

## What to build

Six changes, in dependency order. **Change 0 is a prerequisite** — without it none of the rest can be observed
to work, because the box dies first.

### Atlas — change 0: stop the reaper killing user leases

`lease_reaper.sweep_once` applies heartbeat staleness to every unfinished lease. Only agent-spawned leases can
answer it, because only they are issued a runner token. Scope the check to leases that have one:

```python
# branch 3 — heartbeat staleness
if reason is None and lease.get("status") != "provisioning" and _has_runner_token(lease):
    ...
```

Leases without a runner token stay bounded by plan TTL, wallet exhaustion, explicit release, and (after change

1. the budget cap. The reaper's other branches — provider-terminal and provisioning-timeout — continue to apply
   to every lease and should not be narrowed.

**This is a live user-facing bug, not scaffolding for this spec.** It ships first, on its own, with its own
test: a lease with no runner token survives past `HEARTBEAT_STALE_SECONDS`; one with a token still gets reaped.

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

### Atlas — change 3: bound cumulative spend, not just per-lease spend

The cap is per-grant and a grant is per-lease, so an agent can release and re-acquire without limit. The
concurrency cap of 2 bounds how many boxes run at once, not what they cost in total. A $30 budget honoured
twenty times is $600.

Add a **rolling window cap** checked at lease creation: the sum of grants opened by this user in the trailing
window must not exceed the plan's ceiling. Window and ceiling are plan config, alongside
`gpu_sandbox_max_ttl_hours`. Rejection reuses the `402` shape with a distinct `error` code so the client can
tell "this box is too expensive" from "you have spent enough today".

Design this in now. Retrofitting a cumulative cap after users depend on a per-lease one changes the meaning of
a number they already trust.

### Atlas — change 4: attach a persistent volume so exhaustion costs compute, not work

Atlas already has a volumes API — `POST /api/compute/volumes` (10 GB–10 TB), `list_volumes`, `delete_volume`
with a detach requirement. **Leases do not use it.** `LeaseRequest` has no volume field, and the RunPod
provider passes `volumeInGb: 20`, which is a _pod-scoped_ volume RunPod destroys with the pod.

- Add `volume_id?` to `LeaseRequest`.
- Pass it to RunPod as `networkVolumeId`, mounted at `/workspace`.

Budget exhaustion then destroys the pod and leaves the work. The user relaunches against the same volume and
continues. The economics strongly favour it: a network volume costs cents per GB-month against dollars per
GPU-hour, so preserving the work costs approximately nothing next to the compute that produced it.

**Honest limit:** a volume preserves _files_, not _process state_. A run killed mid-epoch still dies; it
resumes only if it was checkpointing to `/workspace`. The volume is the substrate roadmap **56** needs, not a
replacement for it — but it converts "you lost the job" into "you lost the GPU", which is the difference
between a wasted budget and a wasted hour.

### Atlas — change 5: extend a live budget

```
POST /api/compute/leases/{lease_id}/budget
Request:  { additional_cents }
Response: { hard_cap_cents, spent_cents, effective_cap_cents }
```

Raises `hard_cap_cents` on the existing grant, clamped by the wallet and by the rolling cap from change 3.
Same 402 shapes on refusal. Requires no new state — it edits a number change 1 already reads every tick.

Three constraints keep this from re-opening the door the original draft closed:

- **Extension is pull, never push.** Atlas never auto-extends from a remaining balance. Spending without being
  asked is precisely what a budget exists to prevent, and a budget that quietly refills is not a budget.
- **It is not part of enforcement.** If no extension arrives, exhaustion proceeds exactly as change 1 defines.
  Nothing waits for a decision, so a dead agent changes nothing.
- **No warning event is required for it to work.** A notification at ~80% is worth adding for humans, but it is
  advice, not a mechanism, and the cap must not depend on anyone reading it.

### Why RunPod is the managed default

Verified across all four reseller providers: each generates a fresh Ed25519 keypair per lease and the provider
only ever sees the public half, so **the key handed back opens exactly one box** everywhere. They differ in
what they leave behind:

| Provider        | How the public key attaches                                           | Account artifact | Cleaned up on release                |
| --------------- | --------------------------------------------------------------------- | ---------------- | ------------------------------------ |
| **RunPod**      | injected via the `PUBLIC_KEY` env var the base images consume on boot | **none**         | nothing to clean                     |
| Lambda          | registered in the account key registry                                | yes              | yes — on release _and_ failed launch |
| Vast            | posted to account `/ssh/` **and** `/instances/{id}/ssh/`              | yes              | **no**                               |
| Prime Intellect | `POST /ssh_keys/`, referenced as `sshKeyId`                           | yes              | **no**                               |

RunPod is the only one with no account-level trace at all, which is the right property when Atlas owns the box
lifecycle. Its pod-creation body also takes an arbitrary `env` dict — the same lever the Modal spawn path uses
to pass a token and callback URL — so anything Atlas later wants running on boot needs no SSH bootstrap.

**Two Atlas bugs fall out of this table, in the operator account rather than users':** Vast and Prime Intellect
leak one public key per lease, unbounded and forever. Lambda's pattern is the fix. Out of scope here; worth
their own ticket.

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

## The bounds that remain

| Bound               | Owner                | Fires when                               | Status after this spec  |
| ------------------- | -------------------- | ---------------------------------------- | ----------------------- |
| `hard_cap_cents`    | Atlas billing tick   | the approved money is spent              | made functional (ch. 1) |
| Rolling window cap  | Atlas lease creation | cumulative spend hits the period ceiling | new (ch. 3)             |
| Wallet exhaustion   | Atlas billing tick   | the money actually runs out              | already works           |
| Plan TTL (24h)      | Atlas billing sweep  | anything has run absurdly long           | already works           |
| Heartbeat staleness | Atlas lease reaper   | an _agent-spawned_ lease stops reporting | narrowed (ch. 0)        |

Every one is server-side; none can be influenced by the client. **No `expires_at` column is added** — time is
not the thing being authorised, and a second time bound alongside the plan TTL would be redundant.

Note the shape of change 0: it _removes_ a bound from user leases. That is safe precisely because the other
four still apply, and it is required because the bound it removes is one those leases cannot satisfy.

Billing ticks every 60 seconds, so a budget can overrun by up to a minute of rate (~$0.12 on an H100). Approved
budgets are therefore ceilings-plus-a-minute and must never be described as exact.

## What you are accepting

**A budget-exhausted job loses its GPU. With change 4 it need not lose its work.** Attaching a persistent
volume moves the files off the box, so exhaustion costs the compute rather than the run — provided the job
checkpointed to `/workspace`. Roadmap **56** (checkpointing) remains the thing that makes this genuinely good;
change 4 is the substrate it needs, and without it roadmap 56 has nowhere durable to write.

The residual loss is real and accepted: **a run killed mid-epoch that was not checkpointing is gone.** No
server-side mechanism can fix that, because the server cannot know what the process was holding in memory.

**Time is unbounded within a budget.** A cheap CPU lease could run for days inside a small budget. The 24-hour
plan TTL is the only backstop, which is deliberate.

## Testing

**Atlas** follows `backend/tests/test_compute_billing.py`: a `_FakeProvider` registered into the provider
registry, `aiosqlite` + `run_migrations` for an isolated DB, assertions on the verdict and on whether release
was called. Runs under plain `pytest` before the `fly deploy -a thesis-dev` check, so the deploy verifies
integration rather than being the code's first execution.

Cases that must be covered:

- **The property the last attempt missed: a budget of $B at $R/h lasts ≈ B/R hours.** Assert the elapsed
  billable duration, not just that a release eventually happened. This is what catches the un-rolled-back
  acquire-time debit — a $10 budget at $6.99/h dying at 25.8 minutes instead of ~1.4 hours passes every
  release-happened assertion while being off by 3×.
- A lease **with no runner token survives past `HEARTBEAT_STALE_SECONDS`**; one with a token is still reaped
  (change 0). Without this, every budget test silently measures a ten-minute reap instead of the cap.
- Money-path writes are **idempotent**: replaying a tick that already committed does not double-charge.
- The **rolling window cap** rejects an N+1th lease whose grant would exceed the period ceiling, even when each
  individual budget is affordable.
- A lease created with `volume_id` mounts it, and **releasing the lease does not delete the volume**.
- Extension raises the cap, is clamped by wallet and rolling cap, and **exhaustion proceeds normally when no
  extension arrives**.
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

Per change:

- **Change 0** is behavioural only, and its direction is _fewer_ terminations. Leases currently being reaped at
  ten minutes will start surviving — which is the intent, but it means live GPU boxes that used to die on their
  own now run until a real bound fires. Ship it with change 1 close behind, or ship it while the only bounds are
  plan TTL and wallet, and accept that a forgotten box costs up to the TTL.
- **Change 3** needs plan config for the window and ceiling, and a query over recent grants. If grants are not
  already indexed by `(user_id, created_at)`, that index is the migration.
- **Change 4** adds a nullable `volume_id` to the lease row. Volume lifecycle is already modelled by
  `compute_volume_repo`; releasing a lease must **not** cascade a delete.
- **Change 5** adds no column — it edits `hard_cap_cents` in place.

**One migration hazard, from finding 2.** `budget_cents` already exists on the agent-spawn path defaulting to
`500`, where it is display-only. Change 1 makes caps real, so every already-shipped spawn silently acquires a
hard $5 kill. Either raise that default deliberately or exempt spawn-path grants until their budgets are chosen
with enforcement in mind. **This is not a no-op, and the previous draft called it one.**

## Corrections to earlier analysis

Recorded because both errors reached a draft of this document.

- ~~**`atlas compute:up` exists.**~~ **This correction was itself wrong — see the banner at the top.** It exists
  in the Atlas _repo_ but not in the published `@synsci/atlas@0.13.2`, which is what the `^0.13.2` pin
  resolves to. Source and npm disagree at an identical version number. The original finding — that the prompt
  points at a command the installed CLI does not have — was right, and the retraction below is the error.
  It is at `cli/src/atlas-runtime/commands.mjs:922` as a `LOCAL` command (aliases
  `compute:launch`, `compute:lease`), alongside `compute:list` and `compute:ssh` — **in the repo.** An earlier
  draft claimed it existed in no version, which was wrong about the source and right about the artifact.
  ~~**Consequence: the system prompt at `session/prompt.ts:1554-1562` is not broken** and needs no fix. It was
  previously an acceptance criterion; it is removed.~~ **That consequence did not follow.** The published
  package has no `compute:` command, so the prompt did point at something the installed CLI cannot run.
  **Resolved 2026-07-31** on `feat/compute-guardrails`: the guidance is deleted from `session/prompt.ts` and
  from the `research` agent prompt, and replaced by runtime detection via a `compute_status` tool.
- **`compute:up` already takes `max_price` and `dry_run`** — again, **in the repo only**. A per-hour price
  ceiling and a no-spend preview exist in the source parameter set but ship to nobody until the CLI is
  published. Adding `budget_cents` there too would let CLI users have the same cap, once any of it ships.

**The lesson worth carrying:** **four** separate conclusions in this investigation came from reading source and
were wrong about the deployed reality — the CLI's contents, whether the prompt was broken, whether managed
compute was reachable at all, and then (2026-07-31) the parked banner's own claim that reselling was off, which
was read from a default and contradicted by production. Verify against the running system before designing
against it.

The fourth is the sharpest, because it was made _by the correction to the third_. A document written to warn
about this exact failure repeated it one section later.

## Out of scope

- **Roadmap 61** (per-job secrets, never into logs) — belongs to the _local_ runner `compute/jobs.ts`, which has
  no billing involvement. Logs there go straight to a file descriptor unredacted while every job inherits the
  user's Modal, RunPod, Lambda, Vast, W&B and HuggingFace keys. Real problem, separate workstream.
- **Roadmap 56** (checkpointing) — the follow-on that makes budget exhaustion survivable.
- **Roadmap 4** (real BYOK provider API clients) — five separable vendor integrations.
- **Roadmap 52** (`bun:sqlite` for the local runner's state).
- A per-lease `expires_at`, client-side deadline timers, and any client-side price table. (Extension requests
  are now **in** scope — change 5 — but remain outside the enforcement path.)
- **Publishing the Atlas CLI.** `compute:*` has sat unpublished in `main` since `205bbc0` with no version bump;
  `npm` still serves the pre-removal `0.13.2`. Worth its own release, and worth adding `budget_cents` to
  `compute:up` when it happens — but a release, not this design.
- **Fixing the CLI's usability gaps.** Reviewed 2026-07-31: it prints the one-time SSH private key and never
  saves it (so the `ssh_command` it prints cannot work), has no file-transfer command, no exec, and no compute
  tests. Its resolver is genuinely good; everything around it is unfinished. Separate workstream.
- **The `compute:up` SKU race.** Verified by running the CLI from source against production: `compute:up`
  fetches `/compute/options`, picks, then calls `/compute/estimate` — and Vast's SKUs are ephemeral marketplace
  offer IDs that churn in between. Since Vast supplies 204 of the 292 live options it is almost always the
  cheapest pick, so **the default path and `--gpu h100` both fail** with a raw `HTTP 400: Unknown SKU`, while
  `--provider lambda` and `--provider runpod` (stable instance types) succeed. There is no retry.

  Two fixes, either sufficient: re-resolve once on a 400 and pick the next-best offer, or make selection
  server-side so fetch-and-lease is atomic inside Atlas. The second also removes the duplicate resolver
  described under "OpenScience — one tool".

- **Vast and Prime Intellect SSH key leaks** — one public key per lease left in the operator account forever.
  Lambda's delete-on-release pattern is the fix.

## Acceptance criteria

0. **A lease with no runner token is not reaped for heartbeat staleness**, and one with a token still is. Until
   this holds, no other criterion can be observed — the box dies at ten minutes regardless.
1. **A budget of $B at rate $R/h lasts ≈ B/R hours**, asserted on elapsed billable duration. This is the
   headline property and the one the previous attempt's tests and criteria both omitted.
2. The money path is idempotent: a replayed tick does not double-charge.
3. A cumulative rolling cap bounds spend across sequential leases, not merely within one.
4. `volume_id` attaches a persistent volume that **survives lease release**.
5. Extension raises the cap when affordable, is refused with a structured `402` when not, and never fires
   automatically.
6. The billing tick re-debits the grant, so `spent_cents` tracks cumulative spend instead of freezing at hour
   one.
7. A tick whose delta would exceed `hard_cap_cents` releases the lease via the existing release path.
8. `POST /api/compute/leases` accepts optional `budget_cents` and sizes the grant to it.
9. Omitting `budget_cents` preserves today's behaviour exactly — the dashboard and `compute:up` keep working.
10. A budget that cannot fund the first hour is rejected with `402` carrying `affordable_budget_cents`.
11. A budget exceeding the wallet is clamped to the effective balance, and the response reports the effective cap.
12. BYOK leases ignore `budget_cents` and are never debited.
13. The 24-hour plan TTL still fires independently.
14. `pytest` passes with no network access; changes 0 and 1 are each a separate commit with their own tests.
15. The OpenScience tool refuses to launch without an Atlas verdict, surfaces `402` and `429` without retrying,
    and holds no pricing or approval logic.

## Prototype

`backend/cli/src/compute/PROTOTYPE-guardrail-model.ts` and `PROTOTYPE-guardrail-repl.ts` (openscience,
`e12e486`), runnable via `bun run prototype:guardrail`. It was built duration-first, so its `decide()` reasons
about hours rather than a budget — the _gate-mode_ finding (first-hour versus total) is what carried over and
motivated this design. Each unverified Atlas behaviour is a toggle, so verifying the real backend means flipping
switches rather than rewriting the model.
