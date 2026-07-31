# Compute — design

Status: **Mode detection shipped. Managed leases to build.**
Date: 2026-07-31 · single current compute spec
Roadmap: **5**, **51/2**, **55**, **103**; unblocks **56**

How OpenScience gets a GPU: who provisions it, who pays, and what stops it. Spans two repos —
`atlas` (Python/FastAPI) decides and enforces, `openscience` (Bun/TypeScript) relays and obeys. Each
side gets its own implementation plan; this document is the contract between them.

Replaces `compute-management-design.md`, `compute-guardrails-design.md` and
`compute-mode-detection-design.md`, which disagreed with each other and, in places, with the code.

---

## Two paths

| Mode      | Who provisions                    | Atlas role                          | What bounds it              |
| --------- | --------------------------------- | ----------------------------------- | --------------------------- |
| `byok`    | the agent, direct to the provider | none — never sees the key           | the user's own account      |
| `managed` | Atlas                             | provisions, meters, enforces, reaps | budget → wallet → cap → TTL |
| `none`    | —                                 | —                                   | —                           |

These are genuinely different mechanisms, not one flow with a funding flag. BYOK runs on the user's
provider account, which Atlas neither meters nor bills, so there is nothing for Atlas to decide and no
reason for it to custody a provider credential. **Everything below Part A is `managed` only.**

---

# Part A — Mode detection (shipped)

Shipped on `feat/compute-guardrails`. Summarised here because Part B depends on it; the detail lives in
the code and its tests.

`computeBillingMode()` used to return `config.billing?.compute ?? "byok"` without inspecting the
environment, so a user with zero GPU credentials resolved to `byok` — claiming BYOK with nothing to BYOK
with — and "no compute available" had no representation at all.

```ts
export type ComputeSource = "byok" | "managed" | "none"
```

**A credential is the whole test.** An earlier draft required a credential _and_ a matching skill; that
was overruled during implementation, because a capable agent drives a documented cloud API from a bare
key, so the conjunction only produced a false `none` for users holding a workable key.

| Provider        | Env (any group satisfies; all vars within a group required) |
| --------------- | ----------------------------------------------------------- |
| Modal           | `MODAL_TOKEN_ID` **+** `MODAL_TOKEN_SECRET`                 |
| Lambda          | `LAMBDA_API_KEY` \| `LAMBDA_LABS_API_KEY`                   |
| TensorPool      | `TENSORPOOL_KEY` \| `TENSORPOOL_API_KEY`                    |
| Prime Intellect | `PRIME_API_KEY` \| `PRIME_INTELLECT_API_KEY`                |
| RunPod          | `RUNPOD_API_KEY`                                            |
| Vast            | `VAST_API_KEY`                                              |

BYOK wins whenever a credential is present: it is free to the user and needs nothing from Atlas — which
is also why a BYOK user never pays for the availability network call.

`billing.compute` is an **override, never the source of truth**: unset → detection, `"byok"` → BYOK if a
credential exists else `none`, `"managed"` → managed if available else `none`. **An override may narrow
to `none`; it may never manufacture a capability.**

Resolution happens per request, never at startup, at two points that already run per turn: `SkillTool.init`
and the `compute_status` tool. Credentials reach `process.env` from the shell, the Credentials panel and
the Compute panel — and, as the developer's own machine proved, sometimes from dashboard sync →
`synced-env.json` → `preload-env` replay. Startup detection would have reported `none`.

Availability is one authenticated `GET /api/compute/options`, 3s timeout, 5s TTL cache. A failed,
unauthenticated or timed-out call resolves to **unavailable** — failing toward `managed` would reproduce
the original bug of promising an unconfirmed capability.

`ComputeMode.offered()` filters the skill catalog and is non-empty **only in `byok`**. **This is a listing
filter, not a gate:** a hidden skill remains loadable by exact name and the agent still has `bash`. Gating
the load path was considered and declined.

---

# Part B — Managed leases (to build)

## The gap Part A exposed

`compute_status` tells an agent in `managed` mode to run GPU work billed to Credits — and **no mechanism
exists**. There is no launch tool, and the Atlas CLI's `compute:*` commands are unpublished. Since managed
is live in production, every keyless user lands there.

## Trust boundary

**The agent proposes; the server decides.** OpenScience is open source and the agent has `bash`, so any
client-side check is one a fork can delete. Only a decision made over HTTP, behind auth, in a process the
agent does not run, is one it cannot influence.

Corollary: **OpenScience holds no pricing, balance, selection or approval logic.** It relays a proposal
and obeys a verdict.

## The flow

```
agent  compute_status                      → mode=managed, balance_usd
agent  compute_launch { gpu: "h100", count: 1, budget_cents: 3000, max_hourly_cents?, volume_id? }
        └─ permission gate (default ask):
           "RunPod H100 · $2.79/hr · cap $30.00 · balance $198.83"
Atlas  resolve cheapest live offer matching gpu + count + max_hourly_cents
       check wallet funds 1h AND rolling window has headroom
       clamp budget to effective balance
       mint Ed25519 pair · size grant to effective cap · launch pod
       ← { lease_id, ip, ssh_user, private_key, effective_cap_cents, hourly_cents, provider, sku }
OS     write private_key → ~/.config/openscience/compute/<lease_id>.pem  (0600)
       return { lease_id, ip, ssh_user, key_path, effective_cap_cents, hourly_cents } — no key material
agent  bash: ssh -i <key_path> <ssh_user>@<ip> …   scp results back
agent  compute_release { lease_id } → Atlas terminates · OS deletes the .pem
```

## Why budget, not balance

The obvious design is to check the wallet each hour and stop the box when it can no longer fund another
one. That bound is **the user's entire balance** — a forgotten H100 against a $500 wallet costs $500, and
sequential re-leasing is unbounded on top of that.

A per-run budget bounds the _run_. The agent proposes _"this is worth up to $30"_, not _"this needs four
hours"_ — an LLM can judge the first and cannot predict the second, and it is a wrong duration estimate
that forces extension paths, warning windows and re-estimation loops into a design.

Three consequences, all simplifying: exhaustion is a fact the server observes, so no completion signal is
needed; it is arithmetic, so no extension is needed for correctness; and it is server-side, so no agent
liveness is needed.

The wallet remains the outer bound. A $1000 budget against a $15 balance is not an error — it buys $15 of
compute — but **the response reports the effective cap** so the agent can tell the user what was actually
authorised rather than what was asked for.

## Why Atlas resolves the SKU

The agent states requirements (`gpu`, `count`, optional `max_hourly_cents`); Atlas picks the cheapest
matching live offer and leases it in one call. Three reasons, in order of weight:

1. **It fixes the offer-ID race by construction.** `compute:up` fetches options, picks, then estimates —
   and Vast's SKUs are ephemeral marketplace offer IDs that churn in between. Vast supplies 204 of 292
   live options and is therefore almost always the cheapest pick, so the default path fails with a raw
   `HTTP 400: Unknown SKU`. Making fetch-and-lease atomic inside Atlas removes the window.
2. **292 options never enter the context window.**
3. **It keeps every price decision server-side**, which is what the trust boundary already required.

The cost is an Atlas resolver that does not exist yet. The alternative — agent picks, client retries on
400 — puts ranking logic in OpenScience, which is exactly what the boundary forbids.

## Why RunPod is the managed default

Every provider generates a fresh Ed25519 keypair per lease and shows the provider only the public half,
so the returned key opens exactly one box everywhere. They differ in what they leave behind:

| Provider        | Key attachment                                 | Account artifact | Cleaned up                         |
| --------------- | ---------------------------------------------- | ---------------- | ---------------------------------- |
| **RunPod**      | `PUBLIC_KEY` env var consumed on boot          | **none**         | nothing to clean                   |
| Lambda          | account key registry                           | yes              | yes — on release and failed launch |
| Vast            | account `/ssh/` **and** `/instances/{id}/ssh/` | yes              | **no**                             |
| Prime Intellect | `POST /ssh_keys/` → `sshKeyId`                 | yes              | **no**                             |

RunPod is the only one leaving no account-level trace, which is the right property when Atlas owns the
box lifecycle. Its creation body also takes an arbitrary `env` dict, so anything Atlas later wants running
on boot needs no SSH bootstrap.

Vast is cheapest and deepest but is interruptible spot and leaks a key per lease. **Vast and Prime
Intellect leak one public key per lease into the operator account, forever** — Lambda's delete-on-release
is the fix. Separate ticket.

---

## Atlas changes

### Change 0 — scope the lease reaper _(prerequisite, live defect)_

`lease_reaper.sweep_once` branch 3 (`backend/app/jobs/lease_reaper.py:141-144`) applies
`HEARTBEAT_STALE_SECONDS` = 600 (`config.py:69`) to everything returned by
`compute_repo.list_unfinished_leases`, whose own docstring reads _"category-agnostic"_
(`compute_repo.py:456-462`). `create_lease` mints no runner token, and the telemetry endpoint requires
one.

**A user lease cannot prove liveness and is destroyed ~10 minutes after creation**, with provisioning
eating several of those minutes. A $30 budget lease dies having spent about $1.17. No budget can bind
until this is fixed.

Scope the heartbeat check to leases holding a runner token. User leases stay bounded by plan TTL, wallet
exhaustion, explicit release, and the budget cap. The provider-terminal (`:123`) and provisioning-timeout
(`:133`) branches continue to apply to everything.

**Ships first, alone, with its own test.**

### Change 1 — make `hard_cap_cents` a real running cap

The column exists (`migrations.py:522`, `pg_migrations.py:775`) and the atomic ceiling exists
(`compute_repo.py:196` — `AND (spent_cents + ?) <= hard_cap_cents`). But `debit_grant` is called in
exactly four places, all in `lease_manager.py`: acquire for one hour (`:529`), wallet-insufficient
rollback (`:545`), reservation undo (`:77`), and settle true-up estimate→actual (`:209`).
**`compute_billing_service.tick_once` never calls it** — only `usage_service.charge` and `mark_billed`.
So `spent_cents` freezes at hour one and the ceiling is never re-evaluated.

**The billing tick re-debits the grant by the same delta it charges**, releasing the lease when the debit
would exceed the cap — reusing the path that already fires on wallet exhaustion.

**This is not a double charge.** The wallet is money; the grant is an authorisation envelope drawn against
it. An implementer who "de-duplicates" these has removed the cap.

_Known trap:_ the acquire-time debit is reversed on failure and trued up at settle, but **not before the
first tick**. A naive re-debit therefore double-counts hour one — a $10 budget at $6.99/h would die at
25.8 minutes instead of ~1.4 hours. (A predecessor spec stated the debit "is never rolled back", which is
wrong; the rollback paths are `:77` and `:209`. The trap is real, the reasoning for it was not.)

### Change 2 — accept a budget on lease creation

```
POST /api/compute/leases
{ provider?, sku?, gpu?, count?, max_hourly_cents?, region?, node_id?, budget_cents?, volume_id? }
```

`budget_cents` is optional; absent preserves today's behaviour exactly, which matters because the Atlas
dashboard and `compute:up` both call this endpoint without it. Rejection reuses the structured `402`,
extended with `affordable_budget_cents`.

**A budget larger than the wallet is clamped, not rejected.** The response reports the **effective** cap.

**Managed only.** BYOK ignores `budget_cents` and is never debited.

### Change 3 — resolve a SKU from requirements

Accept `{gpu, count, max_hourly_cents?}` in place of an explicit `sku`, resolve to the cheapest live
matching offer, and lease it in the same transaction. Explicit `provider`/`sku` continues to work.

`GET /api/compute/options` (`routes/compute.py:214`) and `POST /api/compute/estimate` (`:244`) already do
the reads; what is new is doing them atomically with the lease.

### Change 4 — bound cumulative spend

The cap is per-grant and a grant is per-lease, so release-and-reacquire is unbounded. What exists today is
`MANAGED_GPU_CONCURRENT` (`lease_manager.py:563`), which bounds concurrent boxes, not total cost. A $30
budget honoured twenty times is $600.

Add a **rolling window cap** at lease creation, with window and ceiling as plan config alongside
`gpu_sandbox_max_ttl_hours`, and a distinct `error` code so clients can tell "this box is too expensive"
from "you have spent enough today".

Design it in now — retrofitting changes the meaning of a number users already trust. If `compute_grants`
is not indexed by `(user_id, created_at)`, that index is the migration.

### Change 5 — attach a persistent volume

Atlas already has `POST /api/compute/volumes` (`routes/compute.py:565`), `list_volumes` and
`delete_volume`. **Leases do not use them**, and the RunPod provider passes `volumeInGb: 20` — a
pod-scoped volume destroyed with the pod.

Add `volume_id?` to the lease request, pass it to RunPod as `networkVolumeId` mounted at `/workspace`.
**Releasing a lease must not cascade a volume delete.**

Budget exhaustion then costs the compute, not the work — a network volume is cents per GB-month against
dollars per GPU-hour.

**Honest limit:** a volume preserves _files_, not _process state_. A run killed mid-epoch still dies
unless it checkpointed to `/workspace`. The volume is the substrate roadmap **56** needs, not a substitute
for it.

### Change 6 — extend a live budget

```
POST /api/compute/leases/{lease_id}/budget   { additional_cents }
→ { hard_cap_cents, spent_cents, effective_cap_cents }
```

Raises the cap on the existing grant, clamped by wallet and rolling cap. No new state — it edits a number
change 1 already reads every tick. Three constraints keep it from reopening the door earlier drafts
closed:

- **Pull, never push.** Atlas never auto-extends. A budget that quietly refills is not a budget.
- **Not part of enforcement.** If no extension arrives, exhaustion proceeds unchanged, so a dead agent
  costs nothing.
- **No warning event required.** An 80% notification is worth adding for humans, but it is advice; the cap
  must never depend on anyone reading it.

---

## OpenScience changes

### Three verbs

| Tool              | Input                                                             | Output                                                                          |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `compute_launch`  | `gpu`, `count`, `budget_cents`, `max_hourly_cents?`, `volume_id?` | `lease_id`, `ip`, `ssh_user`, `key_path`, `effective_cap_cents`, `hourly_cents` |
| `compute_list`    | —                                                                 | running leases: id, provider, sku, ip, spent, cap                               |
| `compute_release` | `lease_id`                                                        | released                                                                        |

Plus `compute_status` (shipped, unchanged). Each verb maps 1:1 to an Atlas endpoint. Separate tools rather
than one `action` parameter, so the permission rule can ask on launch and allow on list.

The agent does the actual work with plain `ssh`/`scp` from `bash`. **No relay, no exec wrapper, no
file-transfer helper** — that path is a remote-execution platform, and it was already designed once and
rejected.

Behaviour:

- **Refuse to launch without a verdict from Atlas.**
- On `402`, surface `affordable_budget_cents` and stop. **Never auto-retry at a smaller budget** — a
  truncated training run is not a cheaper result, it is a discarded one.
- On `429` (concurrency cap), surface rather than retry.
- **No client-side deadline timer**, price table, or SKU ranking.

### The agent never holds key material

`compute_launch` writes the one-time private key to `~/.config/openscience/compute/<lease_id>.pem` at
`0600` and returns only `key_path`. The key stays out of the transcript, out of compaction, and out of
session storage. `compute_release` deletes it.

This is also the fix for the existing Atlas CLI defect: it prints the private key and never saves it, so
the `ssh_command` it prints cannot work.

### Atlas is the truth for what is running

`compute_list` calls `GET /api/compute/leases` rather than reading a local ledger, so there is nothing to
drift and nothing to orphan on crash. The `.pem` is the only local state, because it is the only value
that cannot be re-fetched.

### The approval gate

`compute_launch` goes through the standard permission path. `PermissionNext.evaluate` already defaults to
`ask` when no rule matches (`src/permission/next.ts:237`) and `Permission` has a `.catchall`
(`src/config/config.ts:642`), so the gate is on by default and needs no schema change. The prompt shows
provider, SKU, hourly rate, proposed cap and current balance.

Settings ▸ Compute exposes it as `permission.compute_launch`, so a user who wants unattended overnight
runs sets `allow` deliberately. **This is UX, not enforcement** — a fork can delete it. The server caps
are what actually bind.

---

## The bounds that remain

Verified against the Atlas checkout at HEAD `7b0e9b6`, source-read (not a running deploy).

| Bound               | Owner          | Fires when                            | Today                                       |
| ------------------- | -------------- | ------------------------------------- | ------------------------------------------- |
| `hard_cap_cents`    | billing tick   | approved money is spent               | **column only, does not enforce** — ch. 1   |
| Rolling window cap  | lease creation | cumulative spend hits the ceiling     | **does not exist** — ch. 4                  |
| Wallet exhaustion   | billing tick   | money actually runs out               | **works** (`tick_once:152/225 → :172/239`)  |
| Plan TTL (24h)      | billing sweep  | anything has run absurdly long        | **works** (`_release_stale_gpu_leases:303`) |
| Explicit release    | agent/user     | asked                                 | **works** (`routes/compute.py:513`)         |
| Heartbeat staleness | lease reaper   | an _agent-spawned_ lease stops report | **fires on user leases too** — ch. 0        |

All server-side; none client-influenceable. Change 0 _removes_ a bound from user leases, which is safe
precisely because the others apply and necessary because it is one those leases cannot satisfy.

`COMPUTE_BILLING_TICK_SECONDS` defaults to 60 (`compute_billing_service.py:44`), so a budget can overrun
by up to a minute of rate (~$0.12 on an H100). **Approved budgets are ceilings-plus-a-minute and must
never be described as exact.**

---

## What we deliberately did not build

Design exploration reached a persistent runner daemon on the box, a command queue, a result stream,
scoped storage credentials and a PTY relay — a remote-execution platform, designed before a single box had
been leased through the agent.

The test that settled it: **a productivity feature is admissible only if its absence changes nothing about
enforcement.** Volumes pass (files move off the box before anything fails). Optional extension passes. A
command relay, per-lease `expires_at`, client-side timers and auto-extension all fail — each needs
something alive to act on a signal.

Also excluded: an ephemeral sandbox/exec path alongside SSH leases. It has no user-facing endpoint today
and cannot run multi-hour training, which is the use case that motivated GPU compute at all. Volume
creation stays in the workspace UI rather than becoming a fourth tool.

## What you are accepting

- **A run killed mid-epoch that was not checkpointing is gone.** No server-side mechanism can fix that.
  Change 5 converts "you lost the job" into "you lost the GPU"; roadmap **56** is what makes it good.
- **Time is unbounded within a budget.** A cheap CPU lease could run for days inside a small budget. The
  24-hour plan TTL is the only backstop, deliberately.
- **`none` is guidance, not enforcement.** The agent still has `bash`.

## Known defects, owned elsewhere

- **Atlas CLI unpublished.** `@synsci/atlas@0.13.2` on npm carries 155 command specs and zero `compute:`;
  `3e1d1ca` removed them, `205bbc0` re-added them, no version bump followed. Source and artifact disagree
  at an identical version. A release, not code.
- **CLI usability.** Prints the one-time private key and never saves it; no file transfer, no exec, no
  compute tests.
- **Vast / Prime Intellect SSH key leaks** into the operator account, unbounded.
- **`budget_cents` already exists** on the agent-spawn path defaulting to `500`, display-only. Change 1
  makes caps real, silently giving every shipped spawn a hard $5 kill. **Not a no-op** — raise the default
  deliberately or exempt spawn-path grants.
- **Stale skill names in agent prompts.** `research.txt`'s appendix and `ml.txt` name ~35 skills by
  directory rather than frontmatter `name` (`vllm` → `serving-llms-vllm`), so the agent is told it has
  skills it cannot load. `skills/scholar-evaluation/SKILL.md` has no `name:` at all.

## Out of scope

Roadmap **61** (per-job secrets), **56** (checkpointing), **4** (BYOK provider API clients), **52**
(`bun:sqlite`). Per-lease `expires_at`, client-side deadline timers, client-side price tables,
auto-extension, sandbox/exec paths. Any change to how `billing.llm` resolves.

---

## Testing

Atlas follows `backend/tests/test_compute_billing.py` — `_FakeProvider`, `aiosqlite` + `run_migrations`,
plain `pytest` before any deploy. OpenScience stubs `globalThis.fetch` and exercises the real tool; no
mocks, no network.

- **A budget of $B at $R/h lasts ≈ B/R hours**, asserted on elapsed billable duration. This is the
  headline property and the one the previous attempt omitted from both its tests and its criteria — a $10
  budget dying at 25.8 minutes passes every "release happened" assertion while being off by 3×.
- A lease **without** a runner token survives past `HEARTBEAT_STALE_SECONDS`; one with a token is still
  reaped. Without this, every budget test silently measures a 10-minute reap.
- Money-path writes are idempotent — a replayed tick does not double-charge.
- The rolling cap rejects an N+1th lease even when each individual budget is affordable.
- SKU resolution picks the cheapest offer honouring `max_hourly_cents`, and leases atomically — a stale
  offer ID cannot appear between resolve and lease.
- `volume_id` mounts, and **release does not delete the volume**.
- Extension raises the cap, is clamped, and **exhaustion proceeds normally when none arrives**.
- A tick exceeding `hard_cap_cents` releases; one that fits does not. `spent_cents` accumulates.
- No `budget_cents` → today's behaviour exactly. BYOK ignores it. Plan TTL still fires independently.
- OpenScience: the key is written `0600` and **never appears in the tool result**; release deletes it;
  `402`/`429` surface without retry; launch without a verdict is refused.

Every new assertion must be shown failing against the specific mutation it guards — ideally the _deletion_
of the logic, not its inversion. On this branch alone, five plan-authored test defects were caught in
review, including an assertion that compared whole tool outputs and so passed even with all guidance
collapsed to one string.

## Acceptance criteria

0. A lease with no runner token is not reaped for heartbeat staleness; one with a token still is.
1. A budget of $B at rate $R/h lasts ≈ B/R hours, asserted on elapsed billable duration.
2. The money path is idempotent under a replayed tick.
3. The billing tick re-debits the grant; `spent_cents` accumulates; a tick exceeding the cap releases via
   the existing path.
4. `POST /leases` accepts `budget_cents`; omitting it preserves today's behaviour exactly.
5. A budget exceeding the wallet is clamped, and the response reports the effective cap.
6. `{gpu, count, max_hourly_cents}` resolves to the cheapest matching live offer and leases atomically.
7. A rolling cap bounds spend across sequential leases.
8. `volume_id` attaches a volume that survives lease release.
9. Extension raises the cap when affordable, refuses with a structured `402` when not, never fires
   automatically.
10. BYOK ignores `budget_cents`. Plan TTL fires independently.
11. `compute_launch` refuses to launch without a verdict, surfaces `402`/`429` without retrying, holds no
    pricing or selection logic, writes the key `0600`, and never returns key material.
12. `compute_launch` prompts by default and is silenced only by explicit config.
13. `compute_list` reflects Atlas, not local state — a lease released out-of-band disappears from it.
14. `pytest` and `bun test` pass with no network; changes 0 and 1 are each their own commit.

---

## Verification discipline

Four conclusions in the predecessor investigation came from reading source and were wrong about deployed
reality: the CLI's contents, whether the prompt was broken, whether managed compute was reachable, and the
claim that reselling was off — **the fourth made by a correction to the third.**

Labels in this document:

- **Verified against production `thesis-synsc` (2026-07-31):** `resell_enabled: true`; lambda / runpod /
  vast / prime_intellect operator-funded with 292 launchable options; `/compute/estimate` returns
  `funding: "managed"` with a real rate and runway; the published npm artifact contains no `compute:`
  command; `compute:up`'s default path fails on the Vast SKU race while `--provider lambda|runpod`
  succeeds.
- **Verified against the Atlas checkout at HEAD `7b0e9b6` (source-read, 2026-07-31):** every `file:line`
  citation in Part B — the reaper's branch structure, `debit_grant`'s four call sites and the tick's
  absence from them, the 60s tick default, the 24h GPU TTL sweep, the absence of any rolling cap, and the
  existing endpoint set.

A source-read claim is not a deployed-behaviour claim. Confirm the money path against `pytest` before
relying on it.
