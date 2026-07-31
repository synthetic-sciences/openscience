# Compute — design

Status: **Mode detection shipped. Managed leases to build.**
Date: 2026-07-31 · single current compute spec · revised after adversarial review
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

**Two different things are called BYOK, and they do not coincide.** OpenScience's `byok` means a provider
credential is in `process.env` (`src/compute/mode.ts:70-72`). Atlas has its own, independent notion: a
provider key stored server-side, gated to paid plans (`lease_manager.py:479-484`,
`routes/compute.py:109-123`). A user with an Atlas-stored key and no local env var resolves to `managed`
client-side while Atlas funds the lease as `byok` — rate 0, never debited, `budget_cents` ignored.

Consequence for the gate below: **the quote is the authority on price, not the client's mode.** A prompt
that quotes an hourly rate the user is never charged is a lie in the safe direction, but it is still a
lie; the quote endpoint (change 4) returns the funding classification so the prompt can say "billed to
your own provider account" instead of a price.

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

**Only `compute_status` resolves.** `SkillTool.init` calls `ComputeMode.offered()` (`src/tool/skill.ts:63`),
which deliberately never reaches the availability probe — it is answerable from credentials alone, so a
BYOK or keyless user pays no per-turn network cost (`src/compute/mode.ts:205-224`). Resolution is still
per request rather than at startup, because credentials arrive at unpredictable times: the shell, the
Credentials panel, the Compute panel, and — as the developer's own machine proved — dashboard sync →
`synced-env.json` → `preload-env` replay. Startup detection would have reported `none`.

`session/prompt.ts:1549-1562` injects a stateless per-turn pointer at `compute_status` for
`COMPUTE_AGENTS`. **It must not enumerate tools.** Part B adds three more; a reminder listing them goes
stale the moment the set changes, and the tool descriptions already ride in every request.

Availability is one authenticated `GET /api/compute/options`, 3s timeout (`mode.ts:101`), 5s TTL cache
(`:107`). A failed, unauthenticated or timed-out call resolves to **unavailable** (`:139-148`) — failing
toward `managed` would reproduce the original bug of promising an unconfirmed capability.

**That probe is expensive on the Atlas side and is not cached there.** `_catalog` gathers over
`RESELL_PROVIDERS` (`routes/compute.py:34-45`, `:186-189`) and per-provider exceptions are swallowed into
an empty option list (`:129-132`).

Precisely: **five HTTP requests, not ten.** Six of the ten entries are `ScaffoldProvider`s with no
credential, and `:126-127` returns before any network call — their `list_options` is a pure-Python
sentinel stripped by the `sku` filter at `:133`. Only lambda / runpod / vast / prime_intellect are wired
(`main.py:144-151`), and Vast issues two requests (`vast_provider.py:122-134`). Five requests at 15–20s
provider timeouts still blows the client's 3s budget, so the conclusion holds — but the number matters,
because it is the quantitative argument for change 12.

A paying managed user therefore resolves to `none` whenever the aggregate exceeds 3s. Fail-closed is still
right, but **the catalog needs a server-side cache** (change 12) — and change 3 makes it load-bearing,
because a transiently-erroring Vast silently removes most of the catalog and changes which provider is
"cheapest" with no signal to anyone.

`ComputeMode.offered()` filters the skill catalog and is non-empty **only in `byok`**. **This is a listing
filter, not a gate:** a hidden skill remains loadable by exact name and the agent still has `bash`. Gating
the load path was considered and declined.

### The gap Part A left, which Part B must answer

**RunPod and Vast have no catalogued skills** (`mode.ts:56`, `:60`). A user whose only credential is
`RUNPOD_API_KEY` therefore resolves to `byok`, is told to use the cloud-compute skills, is offered none —
and because `byok` wins whenever a credential exists, managed is suppressed at the same time (`:186`).
They have a key, no skills, and no managed path.

Part B makes this sharper rather than fixing it: `ComputeTools` is registered unconditionally
(`src/tool/registry.ts:135`), so `compute_launch` stays callable while `compute_status` tells the agent
not to launch managed leases (`src/tool/compute.ts:22`). **The three new tools must state their behaviour
in `byok` and `none`** — refuse with the reason, rather than attempting a managed lease the mode says is
unavailable. No criterion covered this before.

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
agent  compute_status                       → mode=managed, balance_usd

agent  compute_launch { gpu:"H100-SXM", count:1, budget_cents:3000, max_hourly_cents?, volume_id? }
       (gpu is a canonical model id — "h100" is too coarse, interconnect changes price and throughput)

OS  →  POST /api/compute/quote { gpu, count, max_hourly_cents, budget_cents }          (change 4)
       ← { provider, sku, hourly_cents, effective_cap_cents, balance_cents, funding }  ADVISORY
       └─ permission gate (default ask) — names the provider, because cheapest-first means it varies:
          "Vast H100 · $1.94/hr · cap $30.00 · balance $198.83"

OS  →  POST /api/compute/leases { gpu, count, max_hourly_cents, budget_cents, volume_id? }
Atlas  RE-RESOLVE — the quote is never trusted or reused
       reserve against wallet + rolling cap ATOMICALLY · clamp budget to effective balance
       mint Ed25519 · size grant to effective cap · launch pod
       ← { lease_id, private_key, effective_cap_cents, hourly_cents, provider, sku }
         (no ssh_host yet — the pod is still `provisioning`)

OS  →  poll GET /api/compute/leases/{id}/connection until status is running AND ssh_host is non-empty
       (bounded; on timeout, RELEASE and report — never leave a paid box the agent cannot reach)
       write private_key → <config>/compute/<lease_id>.pem  (0600)
       ← { lease_id, ssh_host, ssh_port, ssh_user, key_path, effective_cap_cents, hourly_cents }

agent  bash: ssh -i <key_path> -p <ssh_port> <ssh_user>@<ssh_host> …   scp results back

agent  compute_release { lease_id } → Atlas terminates · OS deletes the .pem
       (.pem missing? re-fetch from /connection and rewrite it — Atlas holds it encrypted)
```

**`compute_launch` is three Atlas calls, not one.** An earlier draft claimed each verb maps 1:1 to an
endpoint; that was wrong in a way that hid two missing pieces — see changes 4 and 0.

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

The agent states requirements (`gpu`, `count`, optional `max_hourly_cents`); Atlas picks a matching live
offer and leases it in the same request. Three reasons, in order of weight:

1. **It narrows the offer-ID race.** `compute:up` fetches options, picks, then estimates — and Vast's SKUs
   are ephemeral marketplace offer IDs that churn in between, so the default path fails with a raw
   `HTTP 400: Unknown SKU`.
2. **292 options never enter the context window.**
3. **It keeps every price decision server-side**, which the trust boundary already required.

**It does not eliminate the race, and an earlier draft claiming "by construction" was wrong.**
`create_lease` already re-fetches the catalog and re-validates the SKU server-side immediately before
`provider.acquire` (`routes/compute.py:327-333`), so a server-internal window exists today and change 3
does not close it. No transaction can span a third-party marketplace. **The resolver must therefore
re-resolve and retry on a provider `400`, bounded to N attempts against a re-fetched catalog**, and give
up with a structured error rather than looping.

### Cheapest wins, across every operator provider

**The resolver ranks purely by price.** No provider allow-list, no default provider, no preference — the
cheapest live offer matching the requirements is the one leased. That is the product decision, and the
rest of this document conforms to it.

**Rank on `price_cents_per_hour_display`, not `price_cents_per_hour`.** This distinction is the whole
correctness of the rule. `price_cents_per_hour` is the provider's raw pass-through rate and is set
identically on both funding paths (`routes/compute.py:161`); the column reflecting what the **user** pays
is `price_cents_per_hour_display`, which is `0` when that provider resolves to BYOK (`:162`). Funding is
decided per provider (`:117-123`), so a paid-plan user holding Atlas-stored keys for some providers and
not others has a genuinely mixed catalog — and ranking on the raw rate would prefer a **$1.90/h billed**
offer over a **$2.00/h free** one. Cheapest means cheapest _to the user_.

Match on GPU model and `count`, honour `max_hourly_cents` if given, then take the minimum display rate.
The one real implementation detail is GPU-name normalisation: options expose `name`, `gpu_ram_gb` and
`upstream`, and providers spell the same card differently, so the resolver needs a canonical model map
rather than a substring match.

An earlier draft of this section proposed an allow-list restricted to providers whose release cleans up
after itself, which would have excluded Vast — and Vast supplies 204 of 292 live options. **That is
overruled.** Two consequences follow, and both are now in scope rather than deferred:

- **The key leak stops being rare and becomes the norm** — see below. Change 9 fixes it, and it is no
  longer somebody else's ticket.
- **The offer-ID race is live on the common path**, because Vast's SKUs are the ephemeral ones. Changes 3
  and 4 are therefore mandatory, not optional. There is no version of this design where the agent picks a
  SKU itself and the default path still works.

**Vast is not spot, and a predecessor claim that it was is wrong.** `VastProvider.list_options` queries
`"type": "on-demand"` (`vast_provider.py:110-115`), so cheapest-first does not buy preemption risk. It
also runs two queries — cheapest-first alone never surfaces the datacenter cards, so the premium tier is
fetched by name (`:105-121`) — which means an H100 request reaches real H100 offers rather than bottoming
out in consumer GPUs.

### What cheapest-first obliges us to fix

Atlas generates a fresh Ed25519 keypair per lease and shows the provider only the public half. An earlier
draft concluded from that "the returned key opens exactly one box everywhere." **That is false on Vast,
and the consequence is cross-tenant.**

| Provider        | Key attachment                                 | Account artifact | Cleaned up on release                          |
| --------------- | ---------------------------------------------- | ---------------- | ---------------------------------------------- |
| RunPod          | `PUBLIC_KEY` env var consumed on boot          | **none**         | nothing to clean                               |
| Lambda          | account key registry                           | yes              | yes (`lambda_provider.py:248-268`)             |
| Vast            | account `/ssh/` **and** `/instances/{id}/ssh/` | yes              | **no** (`vast_provider.py:307-325`)            |
| Prime Intellect | `POST /ssh_keys/` → `sshKeyId`                 | yes              | **no** (`prime_intellect_provider.py:306-325`) |

RunPod leaves no account-level trace and its creation body takes an arbitrary `env` dict, so boot-time
setup needs no SSH bootstrap. That makes it the **easiest** provider to operate — it is not the default,
and nothing in this design prefers it.

**Vast's account key registration is a live cross-tenant exposure, today, independent of anything in this
document.** `VastProvider.acquire` posts the per-lease public key to the **account** endpoint
(`vast_provider.py:206-211`), and the module docstring states the purpose plainly: _"registers the public
key on the Vast account (`POST /ssh/`) **so new instances pick it up**"_ (`:10-12`). Under managed funding
every user's lease runs on the single operator credential (`_headers_for` falls back to
`config.VAST_API_KEY`, `:78`). So one user's private key opens another user's box, for as long as the
first key sits on the account when the second instance is created.

The docstring's justification — the account key is _"keyed by content and harmless to reuse"_ (`:15-16`) —
is true for a single-tenant account and false for a reseller.

**Delete-on-release cannot fix this.** Concurrently live leases have their keys on the account by
construction, and `MANAGED_GPU_CONCURRENT` defaults to 2 per user (`config.py:117`) with no global bound.
The fix is to stop registering account-level keys at all: `acquire` already attaches the key to the
instance directly (`:244-248`), described in the code as the fallback _"so SSH works even if the account
key wasn't applied at launch"_. **Verify the per-instance attach alone suffices, then drop the account
`POST /ssh/`.**

This is change 9, and it is a **blocking prerequisite** for making Vast reachable by default — not
something that ships alongside the resolver.

---

## Atlas changes

### Change 0 — make a lease reach `ready`, then scope the reaper _(prerequisite, two parts)_

This is the prerequisite everything else waits on, and **the first draft of this spec got it wrong** —
it named the heartbeat branch, which is the one branch that cannot be killing these leases. The
correction matters because the acceptance criterion it implied would have passed green while every user
lease still died at ten minutes.

**Part (a) — GPU leases never leave `provisioning`.** `RunPodProvider.acquire` returns
`status: "provisioning"` (`runpod_provider.py:183-191`) and `create_lease` persists it. Only two writers
ever flip a lease to `ready`, and neither runs for a managed GPU lease:

- `lease_manager.py:270`, inside `_reconcile_active_cpu_leases`, which iterates `list_active_cpu_leases`
  — **CPU only**.
- `lease_manager.py:690`, inside `LeaseManager.get_lease_status` — which has **no production caller**.
  `grep` finds only `backend/tests/test_compute_lease_manager.py:192` and `:603`; there is no status route
  in `routes/compute.py`.

So the lease dies at **branch 2, `provisioning_timeout`** (`lease_reaper.py:133-136`,
`PROVISION_TIMEOUT_SECONDS` = 600, `config.py:70`) — not branch 3. Branch 3 explicitly excludes
provisioning leases and says so in its own comment (`lease_reaper.py:139-141`).

The fix is a GPU reconcile pass that polls the provider and flips `provisioning` → `ready`, mirroring
what `_reconcile_active_cpu_leases` already does for CPU. `update_lease_status` already accepts
`ssh_host`/`ssh_port` (`compute_repo.py:397-405`) and nothing in production passes them — **the same pass
must persist them**, which is what makes `compute_list` and the `/connection` poll useful.

**Part (b) — then the heartbeat branch becomes the killer.** Once a lease reaches `ready`, branch 3
(`lease_reaper.py:141-144`) applies `HEARTBEAT_STALE_SECONDS` = 600 (`config.py:69`) to it, over
`list_unfinished_leases`, whose docstring reads _"category-agnostic"_ (`compute_repo.py:456-462`).
`create_lease` mints no runner token and the telemetry endpoint requires one, so **a user lease cannot
prove liveness**. Scope the heartbeat check to leases holding a runner token.

**Pin that predicate to a column, because two different credentials are called "the runner token".** The
lease row carries `runner_api_key_id` (`migrations.py:568`), a `thk_*` value set only by the spawn path.
The token the telemetry endpoint authenticates is a separate `thrk_*` value in `runner_tokens`
(`agent_repo.py:371-381`, `routes/agent.py:1829-1840`). The predicate is `runner_api_key_id IS NOT NULL`;
leaving it as prose invites the implementation to guess.

**Part (c) — normalise the status field.** `routes/compute.py:500` returns
`conn.get("status") or lease.get("status")`, mixing four provider vocabularies with the DB's own. The
client's readiness poll cannot be written against it as-is; see the OpenScience section. Normalising it
belongs here because change 0(a) is what introduces the `ready` transition in the first place.

Order matters: (b) alone changes nothing, because branch 2 kills the lease first. (a) alone moves the
death from 10 minutes to 10 minutes. **Both, or neither.**

User leases then stay bounded by plan TTL, wallet exhaustion, explicit release, and the budget cap. The
provider-terminal branch (`:117-131`) continues to apply to everything.

**Part (a) also produces the boot-time dataset** change 10 ranks on, because flipping to `ready` is what
stamps `ready_at`.

#### `PROVISION_TIMEOUT_SECONDS` = 600 is a guess, and cheapest-first tests it

It is a single global number (`config.py:70`) applied to every provider. Measured 7-day boot distributions
put RunPod's median near 59s but Vast's tail past **6 minutes** — so under cheapest-first, which sends
most launches to Vast, a slice of legitimate provisions runs close to the limit and some will exceed it.
A box reaped mid-provision is a launch the user paid for and never received.

**Make the timeout per-provider and set it from the p99 of measured boot times** (change 10), not from a
round number. Until that data exists, raise it for the providers whose observed tail demands it rather
than leaving one value covering a 6× spread.

**Ships first, with its own test, before any budget work.**

### Change 1 — make `hard_cap_cents` a real running cap

The column exists (`migrations.py:522`, `pg_migrations.py:775`) and an atomic ceiling exists
(`compute_repo.py:196` — `AND (spent_cents + ?) <= hard_cap_cents`). But `debit_grant` is called in
exactly four places, all in `lease_manager.py`: acquire for one hour (`:529`), wallet-insufficient
rollback (`:545`), pre-provisioning failure undo (`:77`), and a settle true-up (`:209`).
**`compute_billing_service.tick_once` never calls it** — only `usage_service.charge` and `mark_billed`.
So `spent_cents` freezes at hour one and the ceiling is never re-evaluated.

**The billing tick must re-debit the grant**, releasing the lease when the debit would exceed the cap —
reusing the path that already fires on wallet exhaustion.

**This is not a double charge.** The wallet is money; the grant is an authorisation envelope drawn against
it. An implementer who "de-duplicates" these has removed the cap.

**The acquire-time debit is never refunded on the managed path.** `:209` is unreachable there: it sits in
`reconcile_managed_hold`'s `hold_id`-present branch, and the managed GPU path never sets `hold_id` — it is
initialised `None` at `:456`, never assigned, and the code says so at `:519-525` ("`hold_id` stays None").
`reconcile_managed_hold` returns from `if not hold_id:` at `:120`. Only `:77` fires, and only when
provisioning fails before the box exists.

_(A predecessor spec said the debit "is never rolled back". A correction in the first draft of this
document called that wrong and cited `:77` and `:209`. On the happy managed path the predecessor was
closer to right, and the correction was the error — the fourth-order instance of the failure this
document's last section is about.)_

**Make the grant debit cumulative, mirroring the tick's own idempotency.** The tick is already replay-safe
because it charges `wall_clock_cents(rate, elapsed) - total_spent_cents`
(`compute_billing_service.py:144-148`) — a replay yields `delta <= 0` and skips. `debit_grant` is an
increment (`compute_repo.py:193`), which is not replay-safe and would double-count hour one. Add a
set-to-total variant — `spent_cents = <cumulative charge> + <acquire debit>`, guarded by the same atomic
`WHERE … <= hard_cap_cents AND status = 'active'` — so a replayed tick is a no-op by construction and the
acquire debit is counted exactly once.

Two things the implementer must decide explicitly, because both are money:

- **Write order.** Charge → `mark_billed` → grant debit. A crash between them must not double-charge; the
  cumulative form is what guarantees that.
- **The final increment.** When the debit would exceed the cap, **charge the elapsed time, then release.**
  The user consumed it and the operator owes the provider for it. Skipping the charge loses real money.

_Latent, not live:_ `debit_grant`'s predicate includes `status = 'active'` (`compute_repo.py:195`).
`expire_grants_by_session` (`:204`) is defined and never called, so no grant expires today — but under
this change, any future grant expiry silently becomes "release the lease".

### Change 2 — accept a budget on lease creation

```
POST /api/compute/leases
{ provider?, sku?, gpu?, count?, max_hourly_cents?, region?, node_id?, budget_cents?, volume_id? }
```

`budget_cents` is optional. Rejection reuses the structured `402`, extended with
`affordable_budget_cents`. **A budget larger than the wallet is clamped, not rejected**, and the response
reports the **effective** cap. **Managed only** — BYOK ignores it and is never debited.

**"Absent preserves today's behaviour" is false once change 1 lands, and an earlier draft claimed it was
true.** `routes/compute.py:359-362` already sizes every user grant to
`max(charge_raw * ttl_hours, charge_raw, 1)` with `ttl_hours = 24` on every plan tier (`config.py:468`,
`:481`, `:494`). That number is inert today because nothing enforces it. After change 1 it becomes a live
ceiling — and because the acquire debit consumes hour one up front and is never refunded, **a no-budget
lease dies at ~23h instead of the 24h plan TTL**, for every existing caller including the dashboard and
`compute:up`.

Fix it deliberately: size the default grant to `rate * (ttl + 1)`, or have the cumulative debit account
for the acquire debit so the two do not stack. **Assert unchanged runtime, not merely an accepted
request.**

**Therefore change 1 must not ship alone.** An earlier draft required changes 0 and 1 to be separate
commits, which is right for attribution — but shipping change 1 by itself _is_ shipping the ~23h
regression to every existing caller, because the default-grant fix lives here in change 2. **Changes 1
and 2 land together**, in that order, with criterion 4 gating the pair. Change 0 remains its own commit.

### Change 3 — resolve the cheapest SKU from requirements _(mandatory)_

Accept `{gpu, count, max_hourly_cents?}` in place of an explicit `sku`; rank **every** operator provider's
options by `price_cents_per_hour_display` — the funding-adjusted rate, not the raw one; lease the cheapest
match in the same request. Explicit `provider`/`sku` continues to work for the dashboard and the CLI.

**`count > 1` is thinner than the catalog size suggests.** RunPod hardcodes `"gpu": 1` in its options and
`"gpuCount": 1` on acquire (`runpod_provider.py:124`, `:156`), Vast dedups to one row per
`(gpu_name, count)` (`:142-156`), and Prime to one per `(gpuType, upstream)`
(`prime_intellect_provider.py:138-156`). A resolver tested only at `count = 1` will not exercise the path
most multi-GPU training needs.

Ranking is **cheapest above a reliability floor**, not cheapest outright — see change 10.

#### The canonical GPU map

Providers spell the same card differently, and a substring match on `name` will silently mis-rank.
`"h100"` is too coarse to be an input: **interconnect is part of the model identity**, and the three H100
variants differ in both throughput and price.

```
A10 · A40 · A100-40GB-PCIe · A100-40GB-SXM · A100-80GB-PCIe · A100-80GB-SXM
H100-PCIe · H100-NVL · H100-SXM · H200-NVL · H200-SXM · B200
L4 · L40 · L40S · RTX-3090 · RTX-4090 · RTX-5090 · RTX-6000-Ada
RTX-A6000 · RTX-PRO-6000 · RTX-PRO-6000-WK
```

The resolver takes a canonical id from this set plus `count`. Each provider module maps its own naming
into it, and an option that cannot be mapped is **excluded from ranking rather than guessed at** — a
mis-mapped card is a wrong machine at the wrong price, silently.

This taxonomy is the one a comparable aggregator settled on, which is a reasonable signal that it is the
right granularity rather than over-specification.

**The retry is not optional here.** Vast supplies most of the catalog and its SKUs are ephemeral offer IDs,
so the cheapest pick is usually the raciest one. On a provider `400`, re-resolve against a re-fetched
catalog, bounded to N attempts, then fail with a structured error rather than looping.
`GET /api/compute/options` (`routes/compute.py:214`) already does the read — but it is uncached and costs
five provider requests, so N retries is N full catalog rebuilds and change 4 adds another per launch.
**Change 12 (catalog cache) ships before this**, or the retry path costs more than the lease.

### Change 4 — quote a proposal without spending

```
POST /api/compute/quote  { gpu, count, max_hourly_cents?, budget_cents }
→ { provider, sku, hourly_cents, effective_cap_cents, balance_cents, funding }
```

**Without this the permission gate cannot exist.** The gate must show provider, SKU, rate and effective
cap _before_ money moves, and the client is forbidden from computing any of them. Nothing today can
supply them: `POST /api/compute/estimate` requires an explicit `{provider, sku}` (`EstimateRequest`,
`routes/compute.py:238-241`), which a `{gpu, count}` proposal does not have, and there is no dry-run flag
anywhere in `routes/compute.py`.

**The quote is advisory and is never reused.** `POST /leases` re-resolves from scratch; a quote token
carried into the lease call would reintroduce exactly the stale-offer race change 3 exists to narrow. The
agent may therefore be shown a rate that differs by cents from the one billed — acceptable, and the launch
response's `effective_cap_cents` is what the user is told they authorised.

`funding` lets the prompt distinguish an operator-billed lease from an Atlas-BYOK one, which is charged
at rate 0.

### Change 5 — bound cumulative spend, atomically

The cap is per-grant and a grant is per-lease, so release-and-reacquire is unbounded. What exists is
`MANAGED_GPU_CONCURRENT` (read at `lease_manager.py:508`, default **2** at `config.py:117`), which bounds
concurrent boxes, not total cost. A $30 budget honoured twenty times is $600.

Add a **rolling window cap** at lease creation, with window and ceiling as plan config alongside
`gpu_sandbox_max_ttl_hours`, and a distinct `error` code so clients can tell "this box is too expensive"
from "you have spent enough today".

**It must be atomic, and so must the wallet clamp — but they need different mechanisms, and conflating
them is a vacuous-pass trap.**

_The window cap_ can follow `debit_grant` (`compute_repo.py:187-201`), the one atomic primitive in the
money path: express it as a single conditional write rather than a `SUM` followed by an `INSERT`.

_The wallet clamp cannot._ The balance lives behind `usage_service.effective_balance`, read with a bare
read-then-compare at `lease_manager.py:540-543` — and read **after** the grant was already debited at
`:529`. Two concurrent launches create two separate grants (`routes/compute.py:365`), each sized
`rate × 24h`, so `debit_grant` succeeds for both and the entire race sits in the wallet read. With a
default concurrency of 2 (`config.py:117`), two simultaneous launches on a $3 wallet both pass, and change
2's clamp makes it worse because each clamps to the _full_ effective balance and authorises 2× the wallet.

The one reservation primitive that exists — the pre-auth `hold_id` path (`lease_manager.py:180-216`) — is
deliberately unused on the managed GPU path (`:456`, `:519-525`). So the wallet clamp needs either a real
hold or per-user serialisation, decided explicitly. **A `debit_grant`-shaped window cap satisfies
criterion 6's first half while the wallet still double-authorises**, which is exactly the failure mode the
closing section of this document is about.

`compute_grants` is indexed on `user_id` and `session_id` only (`migrations.py:586-587`,
`pg_migrations.py:1062-1063`). `(user_id, created_at)` is the migration.

Design it in now — retrofitting changes the meaning of a number users already trust.

### Change 6 — attach a persistent volume _(larger than it looks, and cheapest-first makes it harder)_

Atlas has `POST /api/compute/volumes` (`routes/compute.py:565`), `list_volumes` and `delete_volume` — but
**they provision nothing.** `create_volume` clamps a size and writes a `compute_volume_repo` row; no
provider API is called anywhere. The only volume in the compute providers is RunPod's `volumeInGb: 20`
(`runpod_provider.py:159`), which is pod-scoped and destroyed with the pod. So this is not "pass an
existing volume through" — it is "make volumes real", per provider.

**Cheapest-first turns that into a per-provider matrix.** The volume has to exist wherever the resolver
lands, and the four operator providers do not share a network-volume primitive with the same semantics.

Resolution: **`volume_id` is a requirement, not a preference.** When the request carries one, the resolver
ranks only providers with real network-volume support and takes the cheapest of those. That is still
cheapest-first — a volume is a constraint like `gpu` or `count`, not an override of the pricing rule — and
it degrades honestly: a user who wants durable storage pays whatever the cheapest volume-capable provider
costs, and is told which one.

Start with RunPod (`networkVolumeId`, mounted at `/workspace`) and add providers as their volume APIs are
wired. **Releasing a lease must not cascade a volume delete.**

Budget exhaustion then costs the compute, not the work — a network volume is cents per GB-month against
dollars per GPU-hour.

**Honest limit:** a volume preserves _files_, not _process state_. A run killed mid-epoch still dies
unless it checkpointed to `/workspace`. The volume is the substrate roadmap **56** needs, not a substitute
for it.

### Change 7 — extend a live budget

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

### Change 8 — release must not report success it did not achieve

`LeaseManager.release_lease` swallows a provider teardown failure into
`provider_result = {"warning": …}` (`lease_manager.py:801-802`) and then **unconditionally** marks the row
released (`:808`). A released row leaves `list_active_leases` (`compute_repo.py:470-487`) so billing
stops, and leaves `list_unfinished_leases` (`:463-464`, `status NOT IN ('released','failed')`) so the
reaper never revisits it. **The box runs indefinitely on the operator's account with nothing metering
it**, and the route returns 200.

Add a distinct terminal-pending status the reaper re-sweeps, or at minimum surface `provider_result`
so the caller knows teardown failed. Until then, "explicit release works" is only true when the provider
call succeeds.

**A new non-terminal status is not free, and the spec must choose.** Every gate is
`status NOT IN ('released','failed')` — `list_active_leases` (`compute_repo.py:481`, which drives billing
in `tick_once`), `count_active_managed_gpu_leases` (`:347`, which drives `MANAGED_GPU_CONCURRENT`), and
`list_unfinished_leases` (`:464`). So a `release_pending` status lands inside all three: **the user who
asked to release keeps being charged and keeps burning one of their two managed slots**, indefinitely,
because the retry that would clear it is the one that keeps failing.

Decide both explicitly: **stop billing at the release request** (the user asked; the operator's continued
exposure is an operator problem, not theirs) and **free the concurrency slot**, while keeping the row
sweepable for teardown retry. That means the retry set cannot be `list_unfinished_leases` — it needs its
own query.

### Change 9 — SSH key lifecycle _(security prerequisite, ships before change 3)_

Two distinct problems. The first is a live cross-tenant exposure; the second is hygiene that becomes
unbounded under cheapest-first.

**9(a) — stop Vast registering account-level keys.** As above: `POST /ssh/` (`vast_provider.py:206-211`)
puts every lease's public key on the shared operator account so that new instances pick it up. Confirm the
per-instance attach at `:244-248` is sufficient on its own, then remove the account registration. If it is
not sufficient, the account key must be deleted **immediately after instance creation**, not on release —
deleting on release leaves it live for the whole lease, which is exactly the window that matters.

Until 9(a) ships, managed Vast leases are mutually reachable. This is true of production today.

**9(b) — delete the registered key on release and on failed launch.** Lambda is the pattern
(`lambda_provider.py:248-268`), but **it cannot simply be copied**, because Lambda works only through
machinery the other two lack:

- Lambda's `acquire` persists `ssh_key_name = key_name` (`lambda_provider.py:196`), `_delete_ssh_key`
  looks it up by that name (`:230-246`), and `release_lease` forwards it (`lease_manager.py:798-799`).
- **Prime Intellect persists the wrong string.** The key is registered under `key_name`
  (`prime_intellect_provider.py:220`, `:228-230`) and the API returns an `id` (`:203`) used as `sshKeyId`
  (`:245`) — but `acquire` returns `"ssh_key_name": name` (`:274`), the **pod** name, which is
  `atlas-{user_id[:8]}` (`routes/compute.py:384`) and therefore identical across every lease that user
  ever creates. A name-keyed delete would either miss or delete all of that user's keys. The `sshKeyId` is
  discarded.
- **Vast has no identifier at all.** The key is posted as `{"ssh_key": public_openssh}` with no name
  (`:207-211`) and the response is swallowed by a bare `except` (`:212-213`).
- **There is nowhere to store one.** `compute_leases` carries `ssh_key_name` and `ssh_public_key` only
  (`migrations.py:549-553`, `pg_migrations.py:800-804`).
- **"On failed launch" has no hook.** `lease_manager.py:573-584` re-raises and
  `_release_managed_reservation` (`:63-79`) touches only the grant and hold. Cleanup must live inside each
  provider's `acquire`, as Lambda's does at `:186`.

So 9(b) is: fix `prime_intellect_provider.py:274` to return the key id, add a nullable provider-key-id
column, capture Vast's response instead of discarding it, and put failure cleanup inside each `acquire`.
**Test against the provider's key listing, not against the release return value** — a release that returns
success having deleted nothing is the defect.

### Change 10 — measure boot and availability, and rank on it

**Cheapest per hour is a proxy that inverts.** Boot time is billed wall-clock: a six-minute provision on a
$2.16/h H100 spends $0.22 before any work starts, and a box that boots six times slower is not the cheap
one. A comparable aggregator publishes exactly this measurement across providers, and its 7-day
distribution is stark — RunPod a ~59s median with a tight spread, Vast a ~1m9s median with a tail running
past **6m** and a long scatter across the whole range. Vast is worse on the median and far worse on the
variance, and cheapest-first sends most launches to Vast.

**An earlier draft claimed this dataset was free once change 0(a) landed** — `compute_leases.ready_at`
exists (`migrations.py:555`, `pg_migrations.py:806`) and `update_lease_status` stamps it on the transition
to ready (`compute_repo.py:425-427`), so `ready_at - created_at` looked like a boot-time series for
nothing. **Every one of those citations is correct and the conclusion does not follow, three times over.**

**It is quantised to the sweep interval, and the signal is smaller than the interval.** `ready_at` is
`_now()` evaluated when the reconcile _poll_ observes readiness (`compute_repo.py:408`, `:426-428`), not
when the box became ready. Change 0(a) mirrors `_reconcile_active_cpu_leases`, and every existing sweeper
ticks at 60s (`REAPER_TICK_SECONDS`, `config.py:68`; `COMPUTE_BILLING_TICK_SECONDS`,
`compute_billing_service.py:44`). The discrimination this change exists to make is a ~59s median against a
~1m9s median — **a 10s difference under 60s quantisation, biased upward on both sides.** As specified the
measurement cannot resolve the signal it ranks on.

**It is censored at the timeout, which makes the timeout criterion circular.** A boot exceeding
`PROVISION_TIMEOUT_SECONDS` is reaped (`lease_reaper.py:133-136`) and never gets a `ready_at`, so the
sample is truncated at exactly the value we wanted to derive from it. The p99 of the surviving sample can
never exceed the timeout that produced the sample.

**The availability series does not exist.** A reaped lease and a user-released lease write the same row:
`_reap` → `release_lease` → `compute_repo.release_lease` sets `status = 'released'` for both
(`compute_repo.py:549-556`). **Nothing ever writes `'failed'` to `compute_leases`** — the string appears
only inside `NOT IN` filters. The reap reason exists only on an `agent_telemetry` row
(`lease_reaper.py:79-85`), an unmentioned join, and compute-route leases have a `NULL` `node_id`
(`routes/compute.py:303`).

So change 10 needs real instrumentation, and its cost must be priced rather than assumed away:

- **Record boot duration explicitly**, not as a difference of two poll-quantised timestamps. Either poll
  provisioning leases on a tighter cadence than the 60s sweep — which is a provider API call per
  provisioning lease per tick, a cost this document must state — or take the provider's own ready
  timestamp where it reports one.
- **Record a reap reason on the lease**, so released-by-user and reaped-for-timeout are distinguishable
  without joining telemetry that compute leases do not write.
- **Derive timeouts from a deliberately uncensored window** — a period with the timeout raised well past
  the expected tail — rather than from the post-reap sample.

Then aggregate per `(provider, canonical_gpu)` over a rolling window and use it two ways:

- **A floor.** Exclude offers from a provider whose recent failure rate or p95 boot time is beyond
  threshold, then rank the survivors. This keeps the product rule — cheapest wins — while measuring
  "cheapest" correctly.
- **Timeouts** (change 0).

**Cold start must degrade to today's behaviour.** With no history a provider is not penalised; ranking is
pure price until enough leases exist to say otherwise. A floor that silently excludes every provider on
day one is worse than no floor.

Vendor-published signals are worth folding in where they exist and cost nothing —
`VastProvider.list_options` currently discards `reliability2`, `dlperf_per_dphtotal` and `inet_down` from
every offer it reads. `inet_down` matters more than it looks: pulling a 200 GB dataset at 50 Mbit instead
of 5 Gbit is hours of GPU time billed for waiting. **But measured beats published** — vendor scores
describe the host, our telemetry describes what actually happened to our leases.

### Change 11 — pin the image, per provider

**Nothing in this design says what is on the box**, and the answer today is inconsistent in a way that
breaks reproducibility:

| Provider        | Image                                                                           | Pinnable?                     |
| --------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| RunPod          | `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04` (pinned, has `nvcc`) | yes — `imageName` in the body |
| Vast            | `pytorch/pytorch:latest` (`vast_provider.py:220`) — **a floating tag**          | yes — `image` in the body     |
| Lambda          | none set — whatever the provider defaults to                                    | **no image parameter exists** |
| Prime Intellect | none set                                                                        | **no image parameter exists** |

Under cheapest-first the provider varies per launch, so **the environment varies per launch too** — and
`latest` means the same experiment run a month apart gets a different toolchain with no record of it.
For a tool whose purpose is reproducible research, that is a correctness bug, not an ergonomics one.

Define a **minimum environment contract** the agent may rely on and nothing more — a pinned CUDA runtime,
a pinned Python, and a package manager. Anything beyond it the agent installs itself, and **that install
is billed at GPU rates out of the user's budget**, which is the argument for keeping the contract small
and the image warm rather than bootstrapping from bare Ubuntu on every launch.

**Only two of the four providers can be pinned at all.** Lambda's launch body is
`{region_name, instance_type_name, name, quantity, ssh_key_names}` (`lambda_provider.py:174-180`) and
Prime's pod body is `{name, cloudId, gpuType, socket, gpuCount, …}` (`prime_intellect_provider.py:231-249`)
— neither takes an image, and Prime fronts heterogeneous upstreams. An earlier draft demanded pinning for
"every provider the resolver can select" while its own table said two were unset; that criterion could not
have passed.

Resolve it the same way change 6 resolves volumes: **satisfying the environment contract is a
requirement**, so a provider that cannot be pinned is excluded from ranking until its image story is
understood — Lambda ships a fixed OS image that may already satisfy the contract, in which case it is
declared compliant rather than pinned, and that determination is the work. This narrows the pool exactly
like `volume_id` does, and for the same reason: cheapest wins **among boxes that can do the job**.

**Needs a migration.** `compute_leases` has no image column (`migrations.py:532-584`). Record the resolved
image on the lease so a run can be reproduced later.

### Change 12 — cache the options catalog _(prerequisite for 3 and 4)_

`_catalog` is uncached, and every consumer rebuilds it: the availability probe on every `compute_status`,
`/quote` on every launch, `POST /leases` on every launch, and once more per resolver retry. Five provider
requests each at 15–20s timeouts.

Two earlier sections say this must ship before change 3, and an earlier draft then filed it under "known
defects, owned elsewhere" — no number, no owner, no criterion. **It is a numbered change because two
others depend on it.**

Cache per `(user_id, byok_eligible)` with a short TTL, and make the resolver's retry re-fetch
deliberately rather than reusing a cached miss — the retry exists precisely because the cached offer went
stale.

### Change 13 — reap orphaned user leases

Change 0 removes both reaper branches that currently apply to user leases, and `create_lease` mints no
runner token — `set_runner_api_key` has exactly one caller, the spawn path (`agent_tools.py:1755`) — so a
user lease can **never** be heartbeat-reaped by design. That is correct: it is a bound those leases cannot
satisfy.

But it leaves a hole the rest of the design assumes is closed. If the OpenScience process dies between
`POST /leases` and the readiness poll's release — the exact case the release-on-timeout rule exists for —
**nothing releases the box.** `budget_cents` is optional (change 2) and the default grant is `rate × 24h`,
so the worst case is a full-TTL H100 the user never reached and whose key was never written to disk.

Two options, and the spec picks the first: **make `budget_cents` mandatory on the tool path**, so an
orphan is bounded by the budget rather than the TTL. Second, additionally: reap a lease with no runner
token whose `/connection` has not been fetched in N minutes — liveness a user lease _can_ answer, unlike
telemetry.

## OpenScience changes

### Three verbs

| Tool              | Input                                                             | Output                                                                                            |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `compute_launch`  | `gpu`, `count`, `budget_cents`, `max_hourly_cents?`, `volume_id?` | `lease_id`, `ssh_host`, `ssh_port`, `ssh_user`, `key_path`, `effective_cap_cents`, `hourly_cents` |
| `compute_list`    | —                                                                 | unfinished leases: `lease_id`, `provider`, `sku`, `status`, `ssh_host`, `ssh_port`, rate, cap     |
| `compute_release` | `lease_id`                                                        | released, plus any provider teardown warning                                                      |

Plus `compute_status` (shipped, unchanged). Separate tools rather than one `action` parameter, so the
permission rule can ask on launch and allow on list.

The agent does the actual work with plain `ssh`/`scp` from `bash`. **No relay, no exec wrapper, no
file-transfer helper** — that path is a remote-execution platform, and it was already designed once and
rejected.

Behaviour:

- On `402`, surface `affordable_budget_cents` and stop. **Never auto-retry at a smaller budget** — a
  truncated training run is not a cheaper result, it is a discarded one.
- On `429` (concurrency cap) and `409` (already released, `routes/compute.py:531-535`), surface rather
  than retry.
- A non-2xx or malformed launch response **writes no `.pem` and reports no lease**.
- **The readiness poll outlives the server's provisioning timeout, and defers to it.** A client bound set
  _shorter_ than the server's is the bug to avoid: measured Vast boots run past six minutes, so a
  three-minute client timeout would kill launches that were about to succeed. On timeout with the lease
  still live, **release it** — a paid box the agent cannot reach is worse than no box — but a lease the
  server has already reaped needs reporting, not releasing.
- **No client-side deadline timer**, price table, or SKU ranking.

Two prerequisites for that poll, neither of which exists today.

**The bound is a server constant no endpoint returns.** `PROVISION_TIMEOUT_SECONDS` is server env config
(`config.py:70`) and change 0 makes it per-provider. It appears in no response — not `/options`, not
`/estimate`, not the proposed `/quote`, not the launch payload — and under cheapest-first the client does
not know which provider it got until the launch returns. Telling the client to bound at "that provider's
timeout" while exposing neither the provider nor the timeout means hardcoding a duplicate of a server
constant that silently goes stale. **Change 2's response must carry `provider` and
`provisioning_timeout_seconds`.**

**There is no status vocabulary to poll on.** `routes/compute.py:500` returns
`conn.get("status") or lease.get("status")` — two disjoint vocabularies in one field. On the provider
path RunPod maps `running|stopped|terminated|unknown` (`runpod_provider.py:39-43`), Vast
`running|provisioning|stopped|unknown` (`:55-65`), Prime
`provisioning|active|stopped|error|terminating|terminated|unknown` (`prime_intellect_provider.py:42-51`),
and **Lambda passes the raw upstream string through unmapped** (`lambda_provider.py:214`, `:224`). When
the provider call throws it falls back to the DB status: `provisioning|ready|released`.

So `"running"` is unreachable on the DB path, `"ready"` — what change 0(a) writes — is unreachable on the
provider path, Prime says `"active"`, Lambda says whatever Lambda says, and a dead RunPod pod maps to
`"unknown"`. **A client written against either vocabulary breaks on at least two of the four providers.**
Normalise the field as part of change 0 and enumerate the accepted values here; "poll until running" and
"poll until terminal" are both unimplementable as written.

**Polling is not free either.** `get_lease_connection` calls `provider.connection()` on every poll
(`lease_manager.py:742-753`) — an uncached provider HTTP GET. A six-minute Vast boot polled every 5s is
~70 operator-key provider calls per launch. Specify the interval and a backoff.

### SSH coordinates do not exist at launch

Every provider's `acquire()` returns a hardcoded `ssh_port: 22` and **no `ssh_host`** —
`runpod_provider.py:183-191`, `lambda_provider.py:190-198`, `vast_provider.py:257`,
`prime_intellect_provider.py:273`. The real values live only in `provider.connection()`
(`runpod_provider.py:214-232` → `ssh_host: pod.publicIp`, `ssh_port: _ssh_port(pod)`), reachable through
`GET /leases/{id}/connection`.

So `compute_launch` **must poll `/connection`** before returning. A tool that returns the launch payload
directly hands the agent `ssh_host: null, ssh_port: 22` — and a test asserting "`-p` appears when the port
is not 22" passes vacuously, because the port at launch is always 22.

**`-p <ssh_port>` is required, not optional.** RunPod NATs SSH to a high public port and Vast routes
through an ssh-proxy port; `ssh -i key user@host` times out on both. Assert it against a real
RunPod-shaped `/connection` payload, never a launch payload.

### The agent never holds key material

`compute_launch` writes the private key at `<Global.Path.config>/compute/<lease_id>.pem`
(`src/global/index.ts:82`). **Not a hardcoded `~/.config`**, which is wrong whenever `XDG_CONFIG_HOME` is
set — and **not `:46`**, which an earlier draft cited and which is the _cache_ directory (`:47` is
config). A private key under a cache path is the wrong answer twice over.
and returns only `key_path`. The key stays out of the transcript, out of compaction, and out of session
storage. `compute_release` deletes it.

Modes are load-bearing in both directions — `ssh` refuses a group-readable key outright, so this is a
functional requirement as much as a security one:

- `mkdir(dir, { recursive: true, mode: 0o700 })`
- `writeFile(path, key, { mode: 0o600 })` **followed by an explicit `chmod`** — `mode` is ignored when the
  file already exists, so a re-fetch over a stale loose-permission `.pem` would stay loose.
- **`Bun.write()` has no `mode` option.** The house style prefers Bun APIs; here it produces `0644` and a
  broken feature. Use `node:fs/promises`.

### Atlas is the truth for everything, including the key

The private key is **not** one-time and **not** local state. Atlas stores it encrypted on the lease row
(`compute_leases.ssh_key`, via `secret_store`) and `GET /api/compute/leases/{lease_id}/connection`
decrypts it for the authenticated owner (`routes/compute.py:450-508`), added so the Compute tab could
offer a reliable download after a page reload. `GET /api/compute/leases` redacts the blob
(`_redact_lease:424`); the connection endpoint is the one that returns it.

So the `.pem` on disk is a **cache, not a record**. If it is missing — new machine, cleaned config dir,
another session — re-fetch and rewrite it. OpenScience keeps no durable local state it would have to
reconcile against Atlas.

**But a cache with no eviction is not a cache.** `compute_release` is the only deletion path, and every
_server-side_ termination bypasses it: wallet exhaustion (`compute_billing_service.py:172`), plan TTL
(`:342`), the reaper (`lease_reaper.py:58`). Each leaves a `0600` private key on disk permanently. Sweep
on `compute_list` — any local `.pem` whose lease Atlas reports as terminal gets deleted — so the eviction
rides on a call the agent already makes.

`compute_list` calls `GET /api/compute/leases`, which returns `SELECT *` over every lease for the user,
newest first (`compute_repo.py:446-453`). It returns **terminated leases too**, so the tool filters to
non-terminal status rather than presenting the raw list as "what is running".

### The approval gate

**There is no generic per-tool permission gate.** `PermissionNext.evaluate`'s `ask` default
(`src/permission/next.ts:237`) is only consulted when a tool explicitly calls `ctx.ask`
(`src/tool/tool.ts:25`; `src/tool/bash.ts:148,157` is the precedent). A `compute_launch` that omits
`ctx.ask` prompts for nothing and never reaches `evaluate`.

So: `compute_launch` **must call `ctx.ask({ permission: "compute_launch", … })`** with the quote's
provider, SKU, hourly rate, effective cap and balance. `evaluate` then defaults to `ask`, and `Permission`
has a `.catchall` (`src/config/config.ts:642`), so no config schema change is needed.

Settings ▸ Compute exposes it as `permission.compute_launch`, so a user who wants unattended overnight
runs sets `allow` deliberately. **This is UX, not enforcement** — a fork can delete it. The server caps
are what actually bind.

---

## The bounds that remain

Verified against the Atlas checkout at HEAD `7b0e9b6`, source-read (not a running deploy).

| Bound                | Owner          | Fires when                        | Today                                       |
| -------------------- | -------------- | --------------------------------- | ------------------------------------------- |
| `hard_cap_cents`     | billing tick   | approved money is spent           | **column only, does not enforce** — ch. 1   |
| Rolling window cap   | lease creation | cumulative spend hits the ceiling | **does not exist** — ch. 5                  |
| Wallet exhaustion    | billing tick   | money actually runs out           | **works, but races** (`tick_once:152→:172`) |
| Plan TTL (24h)       | billing sweep  | anything has run absurdly long    | **works** (`_release_stale_gpu_leases:303`) |
| Explicit release     | agent/user     | asked                             | **works only if teardown succeeds** — ch. 8 |
| Provisioning timeout | lease reaper   | a lease never boots               | **fires on every user lease** — ch. 0(a)    |
| Heartbeat staleness  | lease reaper   | a booted lease stops reporting    | **will fire once 0(a) lands** — ch. 0(b)    |

All server-side; none client-influenceable. Change 0 _removes_ two bounds from user leases, which is safe
precisely because the others apply and necessary because they are bounds those leases cannot satisfy.

`COMPUTE_BILLING_TICK_SECONDS` defaults to 60 (`compute_billing_service.py:44`) and
`FIRST_BILL_GRACE_SECONDS` is 30 (`:52`), so a budget can overrun by up to ~90s of rate (~$0.17 on an
H100). **Approved budgets are ceilings-plus-90-seconds and must never be described as exact.**

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
  Change 6 converts "you lost the job" into "you lost the GPU"; roadmap **56** is what makes it good.
- **Time is unbounded within a budget.** A cheap CPU lease could run for days inside a small budget. The
  24-hour plan TTL is the only backstop, deliberately.
- **The quoted rate is advisory.** The lease re-resolves, so the billed rate can differ by cents.
- **The provider varies per launch, and so does the box.** Cheapest-first means image, disk, region and
  network differ run to run. The prompt names the provider for exactly this reason. A user who needs a
  specific one passes `provider`/`sku` explicitly, which still works.
- **Durable storage narrows the pool.** Asking for a volume means paying the cheapest volume-capable
  provider, not the cheapest provider.
- **Boot time is billed and varies by minutes across providers.** The floor bounds how bad it gets; it
  does not make a marketplace box boot like a datacenter one.
- **The environment is a contract, not a guarantee of parity.** Two providers satisfying the same pinned
  CUDA/Python contract are still different machines.
- **`none` is guidance, not enforcement.** The agent still has `bash`.

## Known defects, owned elsewhere

- **Atlas CLI unpublished.** `@synsci/atlas@0.13.2` on npm carries 155 command specs and zero `compute:`;
  `3e1d1ca` removed them, `205bbc0` re-added them, no version bump followed. A release, not code.
- **CLI usability.** Prints the private key and never saves it, so the `ssh_command` it prints cannot
  work as shown. Recoverable — `/leases/{id}/connection` re-serves the key — but the CLI does not call it.
  No file transfer, no exec, no compute tests.
- **Six of the ten `RESELL_PROVIDERS` are `ScaffoldProvider` stubs** — registered, `operator: false`, zero
  options, no network call. Scaffolding, not integrations.
- **`budget_cents` already exists** on the agent-spawn path defaulting to `500` (`agent_tools.py:1386`,
  `models/agent.py:101`, `spawn_queue_service.py:69` → `create_grant` at `:1501`), display-only. Change 1
  makes caps real, silently giving every shipped spawn a hard $5 kill. **Not a no-op.**
- **Stale skill names in agent prompts.** `research.txt:353` and `ml.txt:192` name skills by directory
  rather than frontmatter `name` (`vllm` → `serving-llms-vllm`), so the agent is told it has skills it
  cannot load. `skills/scholar-evaluation/SKILL.md` has no frontmatter at all.

## Out of scope

Roadmap **61** (per-job secrets), **56** (checkpointing), **4** (BYOK provider API clients), **52**
(`bun:sqlite`). Per-lease `expires_at`, client-side deadline timers, client-side price tables,
auto-extension, sandbox/exec paths. Any change to how `billing.llm` resolves.

---

## Testing

Atlas follows `backend/tests/test_compute_billing.py` — `_FakeProvider`, `aiosqlite` + `run_migrations`,
plain `pytest` before any deploy. OpenScience stubs `globalThis.fetch` and exercises the real tool; no
mocks, no network.

- **A budget of $B at $R/h lasts B/R hours ± 90s of rate**, asserted on elapsed billable duration. The
  tolerance is not a detail: it is `COMPUTE_BILLING_TICK_SECONDS` + `FIRST_BILL_GRACE_SECONDS`, and
  leaving it unstated lets an implementer pick a tolerance that hides the acquire-debit double-count.
- A user lease survives past **both** `PROVISION_TIMEOUT_SECONDS` **and** `HEARTBEAT_STALE_SECONDS`; a
  runner-token lease is still reaped for heartbeat staleness. Testing only the second passes green while
  the box dies at ten minutes.
- The GPU reconcile pass flips `provisioning` → `ready` **and persists `ssh_host`/`ssh_port`**.
- A replayed tick does not double-charge and does not double-debit the grant.
- **Two concurrent launches against a wallet that funds only one**: exactly one succeeds. Asserted
  separately from the rolling cap, because a `debit_grant`-shaped window cap passes the cap half while the
  wallet still double-authorises.
- The rolling cap rejects an N+1th lease even when each individual budget is affordable.
- Resolution picks the **globally cheapest** matching offer across all operator providers — asserted with
  a fake catalog where the cheapest match is deliberately not the first provider polled, and again where
  it is not the provider the previous test picked. A resolver that always returns one provider must fail.
- Ranking is on the **funding-adjusted** rate: a catalog holding a cheaper billed offer and a dearer BYOK
  offer resolves to the BYOK one.
- Resolution is exercised at `count > 1`, not only `count = 1`.
- GPU-model matching is canonical, not substring: `H100-SXM`, `H100-PCIe` and `H100-NVL` are three
  distinct targets and never satisfy each other; the same card spelled differently across providers maps
  to one id; an unmappable option is excluded rather than guessed.
- The reliability floor excludes a provider whose recent record is beyond threshold **and** leaves ranking
  on pure price when there is no history — a cold-start floor that excludes everything must fail.
- Boot telemetry has **resolution finer than the difference it must detect** — a recorded duration, not a
  difference of 60s-quantised poll timestamps — and a reaped lease is distinguishable from a
  released-by-user one without joining `agent_telemetry`.
- A provision that exceeds a short global timeout but fits that provider's measured p99 is **not** reaped.
- The resolved image is recorded on the lease row, and no provider is launched on a floating tag. A
  provider that cannot satisfy the environment contract is excluded from ranking, not launched anyway.
- Resolution leases the offer it ranked; a provider `400` triggers at most N re-resolves against a
  re-fetched catalog, then a structured error.
- **Vast registers no account-level SSH key** — asserted against the account key listing after a launch,
  which is the cross-tenant property, not the hygiene one. Then: a second user's instance created while
  the first user's lease is live is **not** reachable with the first user's private key.
- Release deletes the provider-side key for Vast and Prime Intellect, on normal release and on failed
  launch, asserted against the provider's key listing. Prime's stored identifier is the key id, not the
  pod name — a test that passes with `name` in that field is testing nothing.
- The launch response carries `provider` and `provisioning_timeout_seconds`.
- The `/connection` status field is normalised: every provider's terminal and ready states map to one
  documented vocabulary, including Lambda's unmapped upstream strings.
- A terminated lease's `.pem` is deleted on the next `compute_list`, including when the termination was
  server-side.
- `compute_launch` in `byok` or `none` refuses with the reason rather than attempting a managed lease.
- The quote spends nothing and creates no lease row.
- `volume_id` mounts, and **release does not delete the volume**.
- Extension raises the cap, is clamped, and **exhaustion proceeds normally when none arrives**.
- A tick exceeding `hard_cap_cents` charges the elapsed time and then releases; one that fits does not.
- A no-budget lease still runs the **full** plan TTL after change 1 — asserted on runtime, not on the
  request being accepted.
- A release whose provider teardown fails does not silently present as success.
- OpenScience: the key is written `0600` in a `0700` directory and **never appears in the tool result**; a
  re-fetch over an existing loose-mode file tightens it; a malformed launch response writes no `.pem`; a
  readiness timeout releases the lease; the connect string carries `-p <ssh_port>` against a real
  `/connection` payload; `compute_list` filters terminated leases; `402`/`429`/`409` surface without retry.

Every new assertion must be shown failing against the specific mutation it guards — ideally the _deletion_
of the logic, not its inversion. On this branch alone, five plan-authored test defects were caught in
review, including an assertion that compared whole tool outputs and so passed even with all guidance
collapsed to one string.

## Acceptance criteria

0. A user lease survives past both `PROVISION_TIMEOUT_SECONDS` and `HEARTBEAT_STALE_SECONDS`; a
   runner-token lease is still reaped for heartbeat staleness; the reconcile pass persists
   `ssh_host`/`ssh_port`.
1. A budget of $B at rate $R/h lasts B/R hours ± 90s of rate, asserted on elapsed billable duration.
2. A replayed tick neither double-charges the wallet nor double-debits the grant.
3. The billing tick re-debits the grant cumulatively; a tick exceeding the cap charges elapsed time and
   then releases.
4. A lease created without `budget_cents` runs the full plan TTL — unchanged **runtime**, not merely an
   accepted request.
5. A budget exceeding the wallet is clamped, and the response reports the effective cap.
6. **Separately asserted:** (a) two concurrent launches against a wallet funding one — exactly one
   succeeds; (b) the rolling cap rejects an N+1th lease. One test covering both passes while the wallet
   still double-authorises.
7. `{gpu, count, max_hourly_cents}` resolves to the **globally cheapest** matching offer across all
   operator providers, ranked on the **funding-adjusted** rate — a cheaper billed offer never beats a
   dearer BYOK one — proven against a catalog where the winner is neither the first provider polled nor
   the same provider twice, exercised at `count > 1`, honouring `max_hourly_cents`, matching GPU models
   canonically, retrying a provider `400` against a re-fetched catalog at most N times, then failing with
   a structured error.
8. `POST /quote` returns provider, SKU, rate, effective cap, balance and funding, and **spends nothing**.
9. **(a)** A launch registers no account-level SSH key on Vast, and a second user's instance created while
   another user's lease is live is not reachable with that user's private key. **(b)** Release deletes the
   provider-side key on Vast and Prime Intellect, on normal release and on failed launch, asserted against
   the provider's key listing; Prime stores the key id, not the pod name.
10. Boot telemetry resolves finer than the difference it must detect, and a reaped lease is
    distinguishable from a released-by-user one without joining `agent_telemetry`. Ranking applies a
    reliability floor and falls back to pure price with no history.
11. `PROVISION_TIMEOUT_SECONDS` is per-provider and derived from an **uncensored** measurement window; a
    provision that exceeds a short global constant but fits its provider's p99 is not reaped.
12. Every provider the resolver can select satisfies the environment contract with a non-floating image,
    the resolved image is recorded on the lease, and a provider that cannot be pinned or declared
    compliant is excluded from ranking.
13. `volume_id` attaches a volume that survives lease release, and narrows the resolver to volume-capable
    providers rather than failing.
14. Extension raises the cap when affordable, refuses with a structured `402` when not, never fires
    automatically.
15. BYOK ignores `budget_cents`. Plan TTL fires independently.
16. A release whose provider teardown fails is not reported as a clean release, **stops billing**, and
    **frees the concurrency slot** while remaining sweepable for teardown retry.
17. An orphaned lease — client dead between creation and the first poll — is bounded by its budget, not
    only by the 24h TTL.
18. `compute_launch` on a non-2xx or malformed response writes no `.pem` and reports no lease; its
    readiness poll is bounded by the `provisioning_timeout_seconds` the launch response carried, against a
    normalised status vocabulary; it never returns key material; it holds no pricing or selection logic.
19. The key is written `0600` inside a `0700` directory, under `Global.Path.config` (**not the cache
    dir**), and a re-fetch over an existing loose-mode file tightens it.
20. A terminated lease's `.pem` is deleted on the next `compute_list`, including on server-side
    termination.
21. `compute_launch` calls `ctx.ask` and prompts by default; `permission.compute_launch: "allow"` silences
    it.
22. The connect string carries `-p <ssh_port>` when a real `/connection` payload reports a non-22 port.
23. `compute_list` filters terminated leases and reflects Atlas, not local state.
24. `compute_launch` in `byok` or `none` refuses with the reason rather than attempting a managed lease.
25. `pytest` and `bun test` pass with no network. Change 0 is its own commit; **changes 1 and 2 land
    together** — shipping 1 alone ships the ~23h regression.

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
  succeeds. **The 204-of-292 Vast share is load-bearing — it is why cheapest-first makes Vast the common
  path, and therefore why change 9 is in scope — and it comes from this production check, not from
  source.**
- **Verified against the Atlas checkout at HEAD `7b0e9b6` (source-read, 2026-07-31):** the `file:line`
  citations in Part B, re-checked after two adversarial reviews. The claim "every citation verified"
  has now been falsified twice; treat it as "checked, not guaranteed", and check the one you are about to
  build on.
- **Not verified:** `compute:up`'s internal fetch→pick→estimate sequence. The Atlas CLI source is in
  neither repo; the commit chronology corroborates the shape but the sequence itself is inferred.

A source-read claim is not a deployed-behaviour claim. Confirm the money path against `pytest` before
relying on it.

### What review caught in this document

Recorded because the pattern is the point. The first draft was written the same way the predecessors
were, and an adversarial pass over the same source found:

- **Change 0 named the wrong reaper branch.** Branch 3 explicitly skips `provisioning` leases; GPU leases
  never leave `provisioning` because both status writers are CPU-only or uncalled. The prerequisite fix
  and its acceptance criterion would both have shipped green while every user lease still died at ten
  minutes.
- **The launch response cannot carry SSH coordinates.** Providers return `ssh_port: 22` and no host at
  acquire. The criterion guarding this passed vacuously, since the port at launch is always 22.
- **The approval gate had no endpoint to source its numbers from.** No dry-run, and `/estimate` needs an
  explicit SKU. The gate was specified as the UX centrepiece and could not have been built.
- **"Cheapest offer" contradicted "RunPod is the default"** two sections apart. Settled by product
  decision in favour of cheapest, which makes the key-leaking providers the common path — and so promotes
  the leak fix from a background ticket into change 9, and makes changes 3 and 4 mandatory rather than
  optional.
- **`:209` is unreachable on the managed path**, so a correction this document made to a predecessor was
  itself the error — the same failure, one generation on.
- **One plain citation miss** (`lease_manager.py:563` for `:508`), against a section claiming every
  citation had been verified.

Two lessons, both cheap to apply: a citation that is literally correct can still fail to support the claim
built on it, and the acceptance criteria are where a wrong mechanism hides — a criterion that cannot fail
is worse than no criterion.

**A second adversarial pass, after that rewrite, found more — including one live security defect.**

- **Vast registers every lease's public key on the shared operator account** so that new instances pick it
  up (`vast_provider.py:206-211`, docstring `:10-16`). One user's private key opens another user's box.
  The draft called this "leaked into the operator account", i.e. hygiene, and proposed delete-on-release —
  which cannot fix it, because concurrently live leases have their keys on the account by construction.
  **This is true of production today and is now change 9(a), a blocking prerequisite.**
- **Change 9 was unimplementable as "follow Lambda".** Prime stores the pod name where the key id belongs
  (`prime_intellect_provider.py:274`, identical across all of a user's leases), Vast keeps no identifier at
  all, there is no column to store one, and "on failed launch" has no hook outside each provider's
  `acquire`.
- **"The dataset is free" was wrong three ways.** `ready_at` is stamped at poll time under a 60s sweep,
  against a signal that is a 10s difference; the sample is censored at the timeout it was meant to derive;
  and no availability series exists, because **nothing ever writes `'failed'`** to `compute_leases`. All
  three citations were literally correct — the same failure as the first pass, one layer deeper.
- **Cheapest-first ranked on the wrong column.** `price_cents_per_hour` is the raw provider rate on both
  funding paths; what the user pays is `price_cents_per_hour_display`, zero on BYOK. The resolver would
  have preferred a billed offer over a free one.
- **Criterion 22 mandated shipping a regression** — change 1 as its own commit _is_ the ~23h regression,
  because the fix lives in change 2.
- **Three criteria could pass while broken:** the concurrency one (satisfied by the window cap while the
  wallet races), the resolver one (silent on funding), the readiness one (no status vocabulary exists, and
  the timeout it bounds on is returned by no endpoint).
- **A citation miss with teeth:** `global/index.ts:46` is the **cache** directory, not config. Following it
  writes a private key to a cache path.

The pattern is now three-for-three: **every round, the errors are in claims built on correct citations,
and in criteria that cannot fail.** Both are cheap to check and neither is caught by re-reading.
