# Compute management — design

Status: **Part 1 shipped. Part 2 ready to plan.**
Date: 2026-07-31 · supersedes [`compute-mode-detection-design.md`](./compute-mode-detection-design.md)
(shipped) and [`compute-guardrails-design.md`](./compute-guardrails-design.md) (revived).
Roadmap: **5**, **51/2**, **55**, **103**; unblocks **56**.

One document for how OpenScience and Atlas decide **who pays for GPU work, whether it is possible at all, and
what bounds the bill**. It replaces two documents that disagreed with each other and with production.

| Part  | What                                                                     | Status                                               |
| ----- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| **1** | Resolve `byok \| managed \| none` at runtime and tell the agent honestly | **Shipped** on `feat/compute-guardrails`             |
| **2** | Bound what managed compute can spend, and make it usable at all          | **To build.** Change 0 is a live-defect prerequisite |

---

## Production reality, verified 2026-07-31

Both predecessor documents were written from source and drew **four** wrong conclusions about the deployed
system. Everything in this section was checked against running services, and claims elsewhere are labelled.

**Managed compute is ON.** `GET /api/compute/options` against `thesis-synsc`:

```
resell_enabled: true          cli_effective_balance_cents: 19883
lambda           managed  operator:true   24 options
runpod           managed  operator:true   37 options
vast             managed  operator:true  204 options
prime_intellect  managed  operator:true   27 options
hyperbolic / coreweave / together / fluidstack / paperspace / nebius
                 unavailable  operator:false  0 options   (ScaffoldProvider, not wired)
```

292 launchable options. `POST /api/compute/estimate` for `lambda/cpu_4x_general` returns
`funding: "managed"`, 20¢/hr, `sufficient: true`, `runway_hours: 994.1`. **The spend path is live today.**

`COMPUTE_RESELL_ENABLED` still _defaults_ to `false` (`backend/app/config.py:383`) — which is what the earlier
analysis read, and why it concluded the opposite. Production sets it.

**The Atlas CLI runs from source with no build step**, authenticated, with all five `compute:*` commands
present — but `@synsci/atlas@0.13.2` on npm has 155 command specs and **zero** `compute:`. `3e1d1ca` removed
them, `0.13.1` and `0.13.2` shipped without them, `205bbc0` re-added them, and no version bump followed.
Source and artifact disagree at an identical version.

---

# Part 1 — Mode detection (shipped)

## What it fixed

`computeBillingMode()` returned `config.billing?.compute ?? "byok"` and never inspected the environment. A user
with zero GPU credentials resolved to `byok` — claiming BYOK with nothing to BYOK with — and "no compute is
available" had no representation at all. Meanwhile the prompt told the agent to run `atlas compute:up` (absent
from the published CLI) and to check `atlas doctor` for compute availability (it reports no compute field).

## The three states

```ts
export type ComputeSource = "byok" | "managed" | "none"
```

| Credentialed provider? | Managed available? | Resolved  | Agent is told                                              |
| ---------------------- | ------------------ | --------- | ---------------------------------------------------------- |
| yes                    | —                  | `byok`    | use the connected providers via the cloud-compute skills   |
| no                     | yes                | `managed` | use managed compute, billed to Credits                     |
| no                     | no                 | `none`    | no compute available — connect a key in Settings ▸ Compute |

BYOK wins when a credential is present: it is free to the user, works today, and needs nothing from Atlas.
That is also why a BYOK user never pays for the availability network call.

### A credential is the whole test

An earlier draft required a credential **and** a matching skill, reasoning that a provider with no skill gave
the agent nothing to act on. **Overruled during implementation:** a capable agent drives a documented cloud API
from a bare key, so the conjunction only produced a false `none` for users holding a perfectly workable key.

| Provider        | Env (any group satisfies; all vars within a group required) | Catalogued skills                                                 |
| --------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Modal           | `MODAL_TOKEN_ID` **+** `MODAL_TOKEN_SECRET`                 | `modal-serverless-gpu`, `modal-ml-training`, `modal-research-gpu` |
| Lambda          | `LAMBDA_API_KEY` \| `LAMBDA_LABS_API_KEY`                   | `lambda-labs-gpu-cloud`                                           |
| TensorPool      | `TENSORPOOL_KEY` \| `TENSORPOOL_API_KEY`                    | `tensorpool-gpu-cloud`                                            |
| Prime Intellect | `PRIME_API_KEY` \| `PRIME_INTELLECT_API_KEY`                | `prime-intellect-lab`                                             |
| RunPod          | `RUNPOD_API_KEY`                                            | none                                                              |
| Vast            | `VAST_API_KEY`                                              | none                                                              |

Modal is the only credential pair; a half-pasted token counts for nothing. Skill names are SKILL.md frontmatter
`name` values — **not** directory names and not category-prefixed. The predecessor document's table
(`cloud-compute/modal`, `cloud-compute/lambda-labs`) matched nothing; hardcoding it would have filtered nothing.

Dropping the skill requirement also removed a failure mode: skills reach a shipped binary from the server
catalog, so under the old rule a catalog that renamed `lambda-labs-gpu-cloud` would have silently marked Lambda
unusable for a user whose key was fine.

## `billing.compute` is an override, never the source of truth

- unset / `null` → detection
- `"byok"` → BYOK if a credential exists, else `none`
- `"managed"` → managed if available, else `none`

**An override may narrow to `none`; it may never manufacture a capability.** Forcing `managed` while holding a
Lambda key still yields `none` when managed is unavailable — it does not silently fall back to BYOK.

The setting is nullable end-to-end (config schema, settings PUT, and an "Auto" card in the UI) because without
that a user who clicked BYOK with no keys was trapped in `none` with no way back.

## Two seams, one resolver, resolved per request

Credentials reach `process.env` from three places: the user's shell, the Credentials panel
(`applyCredentialEnv`, `src/index.ts:102`), and the Compute panel (`applyComputeEnv`, `:106`). Both injections
are wrapped in `.catch(() => {})`.

**Resolution therefore happens on demand and never at startup**, at two points that already run per request:

- `SkillTool.init` — `registry.ts` calls `t.init({ agent })` inside `tools()`, so the catalog is rebuilt every
  turn and a mid-session credential appears on the next turn with no cache to invalidate.
- the `compute_status` tool, whenever the agent asks.

This makes the ordering constraint unbreakable by construction rather than by careful boot sequencing — and it
proved itself in the wild: the developer's Modal credential lives in none of the three expected places, arriving
instead via dashboard sync → `~/.config/openscience/synced-env.json` → `preload-env` replay. Startup detection
would have reported `none`.

Availability is one authenticated `GET /api/compute/options` with a **3s timeout** and a **5s TTL** cache.
A failed, unauthenticated or timed-out call resolves to **unavailable** — failing toward `managed` would
reproduce the original bug of promising an unconfirmed capability. The cache holds the availability verdict
only; credentials are never cached.

## The catalog filter

`ComputeMode.offered()` returns the skills the agent may see, and is non-empty **only in `byok`**. It needs no
network in any state: with an override of `"managed"` the answer is empty regardless, and with no credential it
is empty regardless, so the availability probe is never required to decide it.

Only the six mapped providers' skills are filtered. `fireworks-ai-inference`, `together-ai-inference`,
`tinker-fine-tuning`, `tinker-training-cost` and `skypilot-multi-cloud-orchestration` share the `cloud-compute`
category but are inference APIs and orchestrators keyed by their own credentials — never hidden. RSI-learned
skills are never hidden.

**This is a listing filter, not a gate.** A hidden skill remains loadable by exact name and the agent still has
`bash`. `none` is guidance, not enforcement; gating the load path was considered and deliberately declined.

## `compute_status`

No parameters. Returns `{mode, providers, managed_available, balance_usd?}` plus mode-specific guidance, and
resolves on every call.

The mode changes mid-session — a key connected at turn 3 makes a reminder injected then false by turn 12 — so
nothing is injected per turn. The tool **description** carries the constraint ("check before running GPU work"),
which costs nothing because tool definitions are in every request regardless; the **result** carries the
specifics. `session/prompt.ts` keeps only a stateless one-line pointer for `COMPUTE_AGENTS`.

`balance_usd` comes from `cli_effective_balance_cents` in the same availability response — no second call.

## Verified live, not just tested

| Case                                    | Result                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| Real machine (Modal via dashboard sync) | `Compute: byok`                                                                     |
| `billing.compute=managed` forced        | `Compute: managed`                                                                  |
| `billing.compute=byok`, no credentials  | `Compute: none`, probe skipped                                                      |
| Catalog in `byok`                       | Modal's 3 shown; `lambda-labs-gpu-cloud`, `tensorpool-gpu-cloud` hidden             |
| Catalog in `none`                       | all 5 provider skills hidden; non-provider and learned skills intact                |
| Settings API                            | `GET` returns `null` (not coerced); `PUT "byok"` persists; `PUT null` restores Auto |

Suite: 1488 pass / 1 skip / 1 pre-existing unrelated failure.

---

# Part 2 — Guardrails and usability (to build)

## The gap Part 1 exposed

`compute_status` now tells an agent in `managed` mode to _"run GPU work through managed compute, billed to
Credits"_ — and **no mechanism exists**. There is no `compute_submit`, and `compute:up` is unpublished. Since
managed is live, every keyless user lands there.

Simultaneously the spend path has no ceiling: `POST /api/compute/leases` checks only that the wallet can fund
**one hour**, so a 4-hour job on a 1-hour balance is approved and strands mid-run.

## Trust boundary

**The agent proposes; the server decides.** OpenScience is open source and the agent has `bash`, so any
client-side check is one a fork can delete. Only a decision made over HTTP, behind auth, in a process the agent
does not run, is one it cannot influence.

Corollary: **OpenScience holds no pricing, balance, or approval logic.** It relays a proposal and obeys a
verdict.

## Why budget, not duration

The agent proposes _"this is worth up to $30"_, not _"this needs 4 hours"_. An LLM can judge the first and
cannot predict the second — and a wrong duration estimate is what forced earlier drafts to grow extension
paths, warning windows and re-estimation loops.

Consequences, all simplifying: exhaustion is a fact the server observes, so no completion signal is needed; it
is arithmetic, so no extension is needed for correctness; and it is server-side, so no agent liveness is needed.

## The changes

### Change 0 — stop the reaper killing user leases _(prerequisite, live defect)_

`lease_reaper.sweep_once` applies heartbeat staleness to every unfinished lease:

- `compute_repo.list_unfinished_leases` is explicitly category-agnostic —
  `WHERE status NOT IN ('released','failed')`.
- Branch 3 falls back to `_lease_started` (`started_at or created_at`) when there is no telemetry and reaps past
  `HEARTBEAT_STALE_SECONDS` = 600.
- `create_lease` mints **no runner token**, and `POST /api/agent/runner/telemetry` requires one.

**A user lease cannot prove liveness and is destroyed ~10 minutes after creation**, with provisioning eating
several of those minutes. A $30 budget lease dies having spent about $1.17. No budget can bind and
`atlas compute:up` cannot run a research task until this is fixed.

Scope the check to leases that have a runner token. User leases stay bounded by plan TTL, wallet exhaustion,
explicit release, and (after change 1) the budget cap. The provider-terminal and provisioning-timeout branches
continue to apply to everything.

Ships first, alone, with its own test.

### Change 1 — make `hard_cap_cents` a real running cap

`compute_grants.hard_cap_cents` reads like a running ceiling but is not one: `acquire_lease` debits it once for
one hour, and the billing tick then charges without calling `debit_grant` again, so `spent_cents` freezes.

**The billing tick re-debits the grant by the same delta it charges**, releasing the lease when the debit would
exceed the cap — reusing the path that already fires on wallet exhaustion.

This is **not** a double charge. The wallet is money; the grant is an authorisation envelope drawn against it.
An implementer who "de-duplicates" these has removed the cap.

_Known trap (finding 3):_ the acquire-time debit is never rolled back, so a naive re-debit double-counts hour
one — a $10 budget at $6.99/h would die at 25.8 minutes instead of ~1.4 hours.

### Change 2 — accept a budget on lease creation

```
POST /api/compute/leases
{ provider, sku, region?, node_id?, budget_cents?, volume_id? }
```

`budget_cents` is optional; absent preserves today's behaviour exactly (the dashboard and `compute:up` both call
this endpoint without it). Rejection reuses the structured 402, extended with `affordable_budget_cents`.

**A budget larger than the wallet is clamped, not rejected** — the wallet is always the outer bound. The
response reports the **effective** cap so the agent can tell the user what was actually authorised.

**Managed only.** BYOK runs on the user's own account, which Atlas neither meters nor bills.

### Change 3 — bound cumulative spend

The cap is per-grant and a grant is per-lease, so release-and-reacquire is unbounded; the concurrency cap of 2
bounds concurrent boxes, not total cost. A $30 budget honoured twenty times is $600.

Add a **rolling window cap** at lease creation, with window and ceiling as plan config alongside
`gpu_sandbox_max_ttl_hours`, and a distinct `error` code so clients can distinguish "this box is too expensive"
from "you have spent enough today".

Design it in now — retrofitting changes the meaning of a number users already trust.

### Change 4 — attach a persistent volume

Atlas already has `POST /api/compute/volumes` (10 GB–10 TB), `list_volumes`, `delete_volume`. **Leases do not
use it**, and the RunPod provider passes `volumeInGb: 20`, a pod-scoped volume destroyed with the pod.

Add `volume_id?` to the lease request and pass it to RunPod as `networkVolumeId`, mounted at `/workspace`.
Releasing a lease must **not** cascade a volume delete.

Budget exhaustion then costs the compute, not the work. A network volume is cents per GB-month against dollars
per GPU-hour, so preserving the work costs approximately nothing.

**Honest limit:** a volume preserves _files_, not _process state_. A run killed mid-epoch still dies unless it
checkpointed to `/workspace`. The volume is the substrate roadmap **56** needs, not a substitute for it.

### Change 5 — extend a live budget

```
POST /api/compute/leases/{lease_id}/budget   { additional_cents }
→ { hard_cap_cents, spent_cents, effective_cap_cents }
```

Raises the cap on the existing grant, clamped by wallet and rolling cap. No new state — it edits a number change
1 already reads every tick.

Three constraints keep it from reopening the door earlier drafts closed:

- **Pull, never push.** Atlas never auto-extends. A budget that quietly refills is not a budget.
- **Not part of enforcement.** If no extension arrives, exhaustion proceeds unchanged, so a dead agent costs
  nothing.
- **No warning event required.** An 80% notification is worth adding for humans, but it is advice; the cap must
  never depend on anyone reading it.

### Why RunPod is the managed default

Every provider generates a fresh Ed25519 keypair per lease and only ever shows the provider the public half, so
the returned key opens exactly one box everywhere. They differ in what they leave behind:

| Provider        | Key attachment                                 | Account artifact | Cleaned up                         |
| --------------- | ---------------------------------------------- | ---------------- | ---------------------------------- |
| **RunPod**      | `PUBLIC_KEY` env var consumed on boot          | **none**         | nothing to clean                   |
| Lambda          | account key registry                           | yes              | yes — on release and failed launch |
| Vast            | account `/ssh/` **and** `/instances/{id}/ssh/` | yes              | **no**                             |
| Prime Intellect | `POST /ssh_keys/` → `sshKeyId`                 | yes              | **no**                             |

RunPod is the only one with no account-level trace, which is the right property when Atlas owns the box
lifecycle. Its creation body also takes an arbitrary `env` dict — the same lever the Modal spawn path uses to
pass a runner token and callback URL — so anything Atlas later wants running on boot needs no SSH bootstrap.

Vast is cheapest and deepest (204 of 292 options) but is interruptible spot, leaks a key per lease, and its SKUs
are ephemeral offer IDs (see Known defects).

### OpenScience — one thin tool

1. `compute_status` (shipped) to learn the mode.
2. `GET /api/compute/options` → the agent picks a SKU. **Selection is the agent's job**, so no client-side
   resolver and no wrapper around `compute:up`.
3. Submit `{provider, sku, budget_cents, volume_id?}`. **Refuse to launch without a verdict from Atlas.**
4. On `402`, surface `affordable_budget_cents` and stop. **Never auto-retry at a smaller budget** — a truncated
   training run is not a cheaper result, it is a discarded one.
5. On `429` (concurrency cap), surface rather than retry.
6. Release on request. **No client-side deadline timer.**

## The bounds that remain

| Bound               | Owner          | Fires when                               | Status                  |
| ------------------- | -------------- | ---------------------------------------- | ----------------------- |
| `hard_cap_cents`    | billing tick   | approved money is spent                  | made functional (ch. 1) |
| Rolling window cap  | lease creation | cumulative spend hits the ceiling        | new (ch. 3)             |
| Wallet exhaustion   | billing tick   | money actually runs out                  | already works           |
| Plan TTL (24h)      | billing sweep  | anything has run absurdly long           | already works           |
| Heartbeat staleness | lease reaper   | an _agent-spawned_ lease stops reporting | narrowed (ch. 0)        |

All server-side; none client-influenceable. Change 0 _removes_ a bound from user leases, which is safe precisely
because the other four apply and necessary because it is one those leases cannot satisfy.

Billing ticks every 60s, so a budget can overrun by up to a minute of rate (~$0.12 on an H100). Approved budgets
are ceilings-plus-a-minute and must never be described as exact.

---

## What we deliberately did not build

Design exploration reached a persistent runner daemon on the box, a command queue, a result stream, scoped
storage credentials and a possible PTY relay — a remote-execution platform, designed before a single box had
been leased through the agent, to fix what was at that point a false string.

The test that settled it: **a productivity feature is admissible only if its absence changes nothing about
enforcement.** Volumes pass (files move off the box before anything fails). Optional extension passes.
A command relay, per-lease `expires_at`, client-side timers and auto-extension all fail — each needs something
alive to act on a signal.

Two things from that exploration survive and are folded in above: enforcement belongs in Atlas, and RunPod is
the right managed default.

---

## Known defects, owned elsewhere

- **The `compute:up` SKU race.** Verified by running the CLI from source against production: it fetches
  options, picks, then estimates — and Vast's offer IDs churn in between. Since Vast supplies 204 of 292
  options it is nearly always cheapest, so **the default path and `--gpu h100` fail** with a raw
  `HTTP 400: Unknown SKU`, while `--provider lambda` and `--provider runpod` succeed. No retry exists. Fix by
  re-resolving once on a 400, or by moving selection server-side (which also makes fetch-and-lease atomic).
- **CLI usability.** It prints the one-time SSH private key and never saves it, so the `ssh_command` it prints
  cannot work. No file transfer, no exec, no compute tests. The resolver is genuinely good; everything around
  it is unfinished.
- **CLI unpublished** — a release, not code.
- **Vast and Prime Intellect leak** one public key per lease into the operator account, forever. Lambda's
  delete-on-release is the fix.
- **Stale skill names in agent prompts.** `research.txt`'s appendix and `ml.txt` name ~35 skills by directory
  rather than frontmatter `name` (`vllm` → `serving-llms-vllm`, `peft` → `peft-fine-tuning`, …), so the agent is
  told it has skills it cannot load. `skills/scholar-evaluation/SKILL.md` has no `name:` at all.
- **`budget_cents` already exists** on the spawn path defaulting to `500`, display-only. Change 1 makes caps
  real, silently giving every shipped spawn a hard $5 kill. **Not a no-op.**

## Out of scope

Roadmap **61** (per-job secrets), **56** (checkpointing — the follow-on change 4 enables), **4** (BYOK provider
API clients), **52** (`bun:sqlite`). Per-lease `expires_at`, client-side deadline timers, client-side price
tables, auto-extension. Any change to how `billing.llm` resolves.

## Testing

Atlas follows `backend/tests/test_compute_billing.py` — `_FakeProvider`, `aiosqlite` + `run_migrations`, plain
`pytest` before any deploy. OpenScience stubs `globalThis.fetch` and exercises the real tool; no mocks, no
network.

Cases that must be covered:

- **A budget of $B at $R/h lasts ≈ B/R hours**, asserted on elapsed billable duration. This is the headline
  property and the one the previous attempt omitted from both its tests and its criteria — a $10 budget dying at
  25.8 minutes passes every "release happened" assertion while being off by 3×.
- A lease **without** a runner token survives past `HEARTBEAT_STALE_SECONDS`; one with a token is still reaped.
  Without this, every budget test silently measures a 10-minute reap.
- Money-path writes are idempotent — a replayed tick does not double-charge.
- The rolling cap rejects an N+1th lease even when each individual budget is affordable.
- `volume_id` mounts, and **release does not delete the volume**.
- Extension raises the cap, is clamped, and **exhaustion proceeds normally when none arrives**.
- A tick exceeding `hard_cap_cents` releases; one that fits does not. `spent_cents` accumulates across ticks.
- No `budget_cents` → today's behaviour exactly. BYOK ignores it. Plan TTL still fires independently.

Every new assertion must be shown failing against the specific mutation it guards — ideally the _deletion_ of
the logic, not its inversion. On this branch alone, five plan-authored test defects were caught in review,
including an assertion that compared whole tool outputs and so passed even with all guidance collapsed to one
string.

## Acceptance criteria (Part 2)

0. A lease with no runner token is not reaped for heartbeat staleness; one with a token still is.
1. A budget of $B at rate $R/h lasts ≈ B/R hours, asserted on elapsed billable duration.
2. The money path is idempotent under a replayed tick.
3. A rolling cap bounds spend across sequential leases.
4. `volume_id` attaches a volume that survives lease release.
5. Extension raises the cap when affordable, refuses with a structured 402 when not, never fires automatically.
6. The billing tick re-debits the grant; `spent_cents` accumulates.
7. A tick exceeding the cap releases via the existing path.
8. `POST /leases` accepts `budget_cents`; omitting it preserves today's behaviour exactly.
9. A budget exceeding the wallet is clamped, and the response reports the effective cap.
10. BYOK ignores `budget_cents`. Plan TTL fires independently.
11. The OpenScience tool refuses to launch without a verdict, surfaces 402/429 without retrying, and holds no
    pricing or approval logic.
12. `pytest` and `bun test` pass with no network; changes 0 and 1 are each their own commit.

---

## Verification discipline

Four conclusions in this investigation came from reading source and were wrong about deployed reality: the
CLI's contents, whether the prompt was broken, whether managed compute was reachable, and then the parked
banner's own claim that reselling was off — **the fourth made by a correction to the third.** A document
written to warn about this failure repeated it one section later.

Claims in this document are labelled: the production-reality section and Part 1's verification table were
checked against running services. The billing tick's debit behaviour, grant accounting, and the reaper's exact
reap path are **read from source only** — confirm against a test before relying on them.
